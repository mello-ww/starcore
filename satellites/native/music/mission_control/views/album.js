import * as api from "../api.js";
import * as store from "../store.js";
import { encode } from "../router.js";
import { albumMenu, addToPlaylist, startRadio } from "../ui/actions.js";
import { artwork } from "../ui/artwork.js";
import { button, el, iconButton, longDuration, plural } from "/media/dom.js";
import { albumCard, header, likeButton, link, playButtons, qualityBadge, shelf, trackList } from "../ui/lists.js";

export async function render({ node, parts, alive }) {
    const album = await api.get(`albums/${encode(parts[0])}`);
    if (!alive()) {
        return;
    }
    const context = `album:${album.id}`;
    const meta = [
        album.artist_id ? link(album.artist, `artist/${encode(album.artist_id)}`) : album.artist,
        album.year ? String(album.year) : null,
        `${plural(album.tracks.length, "song")}, ${longDuration(album.duration)}`,
        qualityBadge(album.quality),
    ];
    const pinned = store.isPinned("album", album.id);
    const hero = header({
        art: artwork(album.artwork ? album.id : null, 600, "mu-art mu-hero-art"),
        kind: { single: "Single", ep: "EP", compilation: "Compilation" }[album.type] || "Album",
        title: album.album,
        meta,
        actions: [
            ...playButtons(async () => album.tracks, context),
            likeButton("album", album.id, "Save album to Your Library"),
            iconButton("plus", "Add album to playlist", () => addToPlaylist(album.tracks)),
            iconButton("radio", "Album radio", () => startRadio("album", album.id, `${album.album} radio`)),
            button(pinned ? "Unpin" : "Pin", "mu-chip", async (event) => {
                await store.setPinned("album", album.id, !store.isPinned("album", album.id)).catch((error) => store.toast(error.message, "error"));
                event.target.textContent = store.isPinned("album", album.id) ? "Unpin" : "Pin";
            }),
            iconButton("more", "More options", (event) => albumMenu(album, event)),
        ],
    });
    node.append(hero);

    const discs = new Map();
    for (const track of album.tracks) {
        const disc = track.disc || 1;
        if (!discs.has(disc)) {
            discs.set(disc, []);
        }
        discs.get(disc).push(track);
    }
    for (const [disc, tracks] of discs) {
        if (discs.size > 1) {
            node.append(el("h3", "mu-disc", `Disc ${disc}`));
        }
        node.append(trackList(tracks, { numbered: "track", album: false, context }));
    }

    const credits = el("dl", "mu-facts mu-album-credits");
    const add = (label, values) => {
        if (values && values.length) {
            credits.append(el("dt", null, label), el("dd", null, values.join(", ")));
        }
    };
    add("Released", [album.date || album.year].filter(Boolean).map(String));
    add("Genres", album.genres);
    add("Label", album.credits.label);
    add("Composers", album.credits.composer);
    add("Producers", album.credits.producer);
    add("Quality", [album.quality.label]);
    if (album.credits.copyright.length) {
        add("Copyright", album.credits.copyright);
    }
    if (credits.childNodes.length) {
        const section = el("section", "mu-shelf");
        section.append(el("h3", null, "Credits"), credits);
        node.append(section);
    }
    if (album.more_by_artist.length) {
        node.append(shelf(`More by ${album.artist}`, album.more_by_artist.map((other) => albumCard(other, [other.year, other.type].filter(Boolean).join(" · ")))));
    }
}
