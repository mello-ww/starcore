import * as api from "../api.js";
import * as store from "../store.js";
import { encode, go } from "../router.js";
import { startRadio } from "../ui/actions.js";
import { artwork } from "../ui/artwork.js";
import { button, el, iconButton, plural } from "../ui/dom.js";
import { albumCard, header, playButtons, shelf, trackList } from "../ui/lists.js";

export async function render({ node, parts, alive }) {
    const artist = await api.get(`artists/${encode(parts[0])}`);
    if (!alive()) {
        return;
    }
    const context = `artist:${artist.id}`;
    const allTracks = async () => (await api.get(`tracks${api.query({ artist: artist.id, sort: "album" })}`)).tracks;
    const follow = button(store.isLiked("artist", artist.id) ? "Following" : "Follow", "mu-chip mu-follow", async () => {
        await store.toggleLiked("artist", artist.id).catch((error) => store.toast(error.message, "error"));
        follow.textContent = store.isLiked("artist", artist.id) ? "Following" : "Follow";
    });
    node.append(header({
        art: artwork(artist.artwork, 600, "mu-art mu-hero-art mu-art-round"),
        kind: "Artist",
        title: artist.name,
        meta: [plural(artist.tracks, "song"), artist.genres.slice(0, 3).join(", ") || null],
        actions: [...playButtons(allTracks, context), follow, iconButton("radio", "Artist radio", () => startRadio("artist", artist.id, `${artist.name} radio`))],
    }));
    if (artist.top_tracks.length) {
        const section = el("section", "mu-shelf");
        section.append(el("h3", null, "Popular in your library"), el("p", "mu-shelf-sub", "Ordered by how often you play them"),
            trackList(artist.top_tracks, { art: true, context }));
        node.append(section);
    }
    if (artist.albums.length) {
        node.append(shelf("Albums", artist.albums.map((album) => albumCard(album, [album.year, album.type === "compilation" ? "Compilation" : null].filter(Boolean).join(" · ")))));
    }
    if (artist.singles.length) {
        node.append(shelf("Singles and EPs", artist.singles.map((album) => albumCard(album, [album.year, album.type.toUpperCase()].filter(Boolean).join(" · ")))));
    }
    if (artist.appears_on.length) {
        node.append(shelf("Appears on", artist.appears_on.map((album) => albumCard(album))));
    }
    if (artist.similar.length) {
        const section = el("section", "mu-shelf");
        section.append(el("h3", null, "Similar artists in your library"));
        const chips = el("div", "mu-similar");
        for (const other of artist.similar) {
            const chip = button(null, "mu-similar-item", () => go(`artist/${encode(other.id)}`));
            chip.append(el("strong", null, other.name), el("span", null, other.reason));
            chips.append(chip);
        }
        section.append(chips);
        node.append(section);
    }
}
