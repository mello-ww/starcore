import * as api from "../api.js";
import { encode } from "../router.js";
import { mosaic } from "../ui/artwork.js";
import { emptyState } from "/media/dom.js";
import { albumCard, header, playButtons, shelf, totals, trackList } from "../ui/lists.js";

// mixes, radio stations, moods and genres: generated lists that all render the same way
export async function render({ node, view, parts, alive }) {
    let payload;
    let kind;
    let context;
    let description = null;
    if (view === "mix") {
        payload = await api.get(`mixes/${encode(parts[0])}`);
        kind = payload.kind === "daily" ? "Daily Mix" : payload.kind === "genre" ? "Genre mix" : "Mix";
        context = `mix:${payload.id}`;
        description = payload.description;
    } else if (view === "radio") {
        payload = await api.get(`radio/${encode(parts[0])}/${encode(parts.slice(1).join("/"))}`);
        kind = "Radio";
        context = `radio:${parts[0]}-${parts[1]}`;
        description = "Songs from your library around this seed. Each one says why it's here.";
    } else if (view === "mood") {
        payload = await api.get(`moods/${encode(parts[0])}`);
        kind = "Mood";
        context = `mix:mood-${payload.id}`;
        description = `Picked from songs tagged ${payload.genres.join(", ")}`;
    } else {
        const genre = parts.join("/");
        const [tracks, albums] = await Promise.all([
            api.get(`tracks${api.query({ genre, sort: "added", order: "desc", limit: 500 })}`),
            api.get(`albums${api.query({ genre, sort: "released", order: "desc" })}`),
        ]);
        payload = { name: genre, tracks: tracks.tracks, albums: albums.albums, mosaic: albums.albums.filter((album) => album.artwork).slice(0, 4).map((album) => album.id) };
        kind = "Genre";
        context = `genre:${genre.toLowerCase().replace(/[^\w]+/g, "-")}`;
    }
    if (!alive()) {
        return;
    }
    const tracks = payload.tracks || [];
    const ids = payload.mosaic || [...new Set(tracks.filter((track) => track.has_artwork).map((track) => track.album_id))].slice(0, 4);
    node.append(header({
        art: mosaic(ids, null, "mu-art mu-hero-art", 600),
        kind,
        title: payload.name,
        description,
        meta: [totals(tracks)],
        actions: playButtons(async () => tracks, context),
    }));
    if (view === "genre" && payload.albums.length) {
        node.append(shelf("Albums", payload.albums.slice(0, 24).map((album) => albumCard(album))));
    }
    node.append(tracks.length ? trackList(tracks, { art: true, reason: view !== "genre", context })
        : emptyState("Nothing here yet", "This list fills in as your library and listening grow."));
}
