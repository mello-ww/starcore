import * as api from "../api.js";
import * as store from "../store.js";
import { encode, go } from "../router.js";
import { button, debounce, el, emptyState, icon, plural } from "/media/dom.js";
import { albumCard, artistCard, grid, header, link, playButtons, playlistCard, totals, trackList } from "../ui/lists.js";
import { createPlaylist, importPlaylist, smartPlaylist } from "./playlist.js";

const TABS = [["playlists", "Playlists"], ["liked", "Liked Songs"], ["albums", "Albums"], ["artists", "Artists"], ["recent", "Recently played"], ["folders", "Folders"], ["genres", "Genres"]];
const ALBUM_SORTS = [["added", "Recently added"], ["title", "Title"], ["artist", "Artist"], ["released", "Release date"], ["quality", "Quality"]];
const TRACK_SORTS = [["liked", "Recently liked"], ["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["duration", "Duration"]];

function matches(text, filter) {
    return !filter || String(text || "").toLowerCase().includes(filter);
}

export async function render({ node, parts, alive }) {
    const tab = TABS.some(([key]) => key === parts[0]) ? parts[0] : "playlists";
    const tabs = el("div", "mu-tabs mu-library-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [key, label] of TABS) {
        const entry = button(label, `mu-tab${key === tab ? " active" : ""}`, () => go(`library/${key}`));
        entry.setAttribute("role", "tab");
        entry.setAttribute("aria-selected", String(key === tab));
        tabs.append(entry);
    }
    const tools = el("div", "mu-library-tools");
    const filter = el("input", "mu-input");
    filter.type = "search";
    filter.placeholder = "Filter";
    filter.setAttribute("aria-label", "Filter this list");
    const content = el("div", "mu-library-content");
    node.append(el("h1", "mu-page-title", "Your Library"), tabs, tools, content);

    const renderers = { playlists, liked, albums, artists, recent, folders, genres };
    await renderers[tab]();

    async function playlists() {
        const folderFilter = el("select", "mu-select");
        folderFilter.setAttribute("aria-label", "Playlist folder");
        tools.append(filter, folderFilter, button("New playlist", "button button-primary", () => createPlaylist()),
            button("Smart playlist", "button", () => smartPlaylist()), button("Import M3U", "button", () => importPlaylist()));
        const draw = () => {
            const list = store.state.playlists;
            const folders = [...new Set(list.map((playlist) => playlist.folder).filter(Boolean))].sort();
            const chosen = folderFilter.value;
            folderFilter.replaceChildren(new Option("All folders", ""), ...folders.map((name) => new Option(name, name)));
            folderFilter.value = folders.includes(chosen) ? chosen : "";
            folderFilter.hidden = !folders.length;
            const text = filter.value.trim().toLowerCase();
            const shown = list.filter((playlist) => matches(playlist.name, text) && (!folderFilter.value || playlist.folder === folderFilter.value));
            if (!list.length) {
                content.replaceChildren(emptyState("Create your first playlist", "Collect songs, or make a smart playlist that fills itself from rules.", button("New playlist", "button button-primary", () => createPlaylist())));
                return;
            }
            const groups = new Map();
            for (const playlist of shown) {
                const key = folderFilter.value ? "" : playlist.folder || "";
                if (!groups.has(key)) {
                    groups.set(key, []);
                }
                groups.get(key).push(playlist);
            }
            const blocks = [];
            for (const [folder, items] of [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))) {
                if (folder) {
                    blocks.push(el("h3", "mu-folder-title", folder));
                }
                blocks.push(grid(items.map((playlist) => {
                    const card = playlistCard(playlist);
                    if (playlist.pinned) {
                        card.classList.add("pinned");
                        card.querySelector(".mu-card-title").prepend(icon("pin", 12), " ");
                    }
                    return card;
                })));
            }
            content.replaceChildren(...(blocks.length ? blocks : [emptyState("No playlists match", "")]));
        };
        filter.addEventListener("input", draw);
        folderFilter.addEventListener("change", draw);
        store.on("playlists", () => alive() && draw());
        draw();
    }

    async function liked() {
        const sort = el("select", "mu-select");
        for (const [value, label] of TRACK_SORTS) {
            sort.append(new Option(label, value));
        }
        tools.append(filter, sort);
        const payload = await api.get("favorites");
        if (!alive()) {
            return;
        }
        const tracks = payload.tracks;
        const head = header({
            art: (() => { const art = el("div", "mu-art mu-liked-art mu-hero-art"); art.append(icon("heart", 64)); return art; })(),
            kind: "Playlist", title: "Liked Songs", meta: [totals(tracks)],
            actions: playButtons(async () => tracks, "liked:all"),
        });
        const list = el("div");
        const draw = () => {
            const text = filter.value.trim().toLowerCase();
            const key = sort.value;
            let shown = tracks.filter((track) => matches(`${track.title} ${track.artist} ${track.album}`, text));
            if (key !== "liked") {
                const field = { title: "title", artist: "artist", album: "album", duration: "duration" }[key];
                shown = [...shown].sort((a, b) => (field === "duration" ? (a.duration || 0) - (b.duration || 0) : String(a[field] || "").localeCompare(String(b[field] || ""))));
            }
            list.replaceChildren(shown.length ? trackList(shown, { art: true, context: "liked:all" })
                : emptyState(tracks.length ? "No liked songs match" : "Songs you like appear here", tracks.length ? "" : "Tap the heart on any song to save it."));
        };
        filter.addEventListener("input", debounce(draw, 120));
        sort.addEventListener("change", draw);
        content.replaceChildren(head, list);
        draw();
    }

    async function albums() {
        const sort = el("select", "mu-select");
        for (const [value, label] of ALBUM_SORTS) {
            sort.append(new Option(label, value));
        }
        const type = el("select", "mu-select");
        for (const [value, label] of [["", "All releases"], ["saved", "Saved albums"], ["album", "Albums"], ["ep", "EPs"], ["single", "Singles"], ["compilation", "Compilations"]]) {
            type.append(new Option(label, value));
        }
        tools.append(filter, sort, type);
        let payload = null;
        const load = async () => {
            content.replaceChildren(el("div", "mu-skeleton mu-skeleton-grid"));
            const release = type.value === "saved" ? "" : type.value;
            payload = await api.get(`albums${api.query({ sort: sort.value, order: ["added", "released", "quality"].includes(sort.value) ? "desc" : "asc", type: release })}`);
            if (alive()) {
                draw();
            }
        };
        const draw = () => {
            const text = filter.value.trim().toLowerCase();
            const pinned = new Set(store.state.pins.filter((pin) => pin.kind === "album").map((pin) => pin.id));
            let shown = payload.albums.filter((album) => matches(`${album.album} ${album.artist}`, text));
            if (type.value === "saved") {
                shown = shown.filter((album) => store.isLiked("album", album.id));
            }
            shown.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
            content.replaceChildren(shown.length ? grid(shown, (album) => albumCard(album)) : emptyState("No albums here", type.value === "saved" ? "Save albums with the heart on an album page." : "Scan your music folder in Settings."));
        };
        filter.addEventListener("input", debounce(() => payload && draw(), 200));
        sort.addEventListener("change", load);
        type.addEventListener("change", load);
        await load();
    }

    async function artists() {
        const which = el("select", "mu-select");
        for (const [value, label] of [["", "Album artists"], ["featured", "All artists"], ["followed", "Following"]]) {
            which.append(new Option(label, value));
        }
        const sort = el("select", "mu-select");
        for (const [value, label] of [["name", "Name"], ["tracks", "Most songs"], ["added", "Recently added"]]) {
            sort.append(new Option(label, value));
        }
        tools.append(filter, which, sort);
        let payload = null;
        const load = async () => {
            payload = await api.get(`artists${api.query({ sort: sort.value, featured: which.value === "featured" ? 1 : undefined })}`);
            if (alive()) {
                draw();
            }
        };
        const draw = () => {
            const text = filter.value.trim().toLowerCase();
            let shown = payload.artists.filter((artist) => matches(artist.name, text));
            if (which.value === "followed") {
                shown = shown.filter((artist) => store.isLiked("artist", artist.id));
            }
            content.replaceChildren(shown.length ? grid(shown, (artist) => artistCard(artist, plural(artist.tracks, "song"))) : emptyState("No artists here", which.value === "followed" ? "Follow artists from their page." : ""));
        };
        filter.addEventListener("input", debounce(() => payload && draw(), 200));
        which.addEventListener("change", load);
        sort.addEventListener("change", load);
        await load();
    }

    async function recent() {
        tools.append(filter);
        const payload = await api.get("history?limit=200");
        if (!alive()) {
            return;
        }
        if (!payload.enabled) {
            content.replaceChildren(emptyState("Listening history is off", "Turn it on in Settings to see what you played and get recommendations.", button("Settings", "button", () => go("settings"))));
            return;
        }
        const draw = () => {
            const text = filter.value.trim().toLowerCase();
            const shown = payload.tracks.filter((track) => matches(`${track.title} ${track.artist} ${track.album}`, text));
            content.replaceChildren(shown.length ? trackList(shown, { art: true, context: "library:recent" }) : emptyState("Nothing played yet", "Songs you listen to appear here."));
        };
        filter.addEventListener("input", debounce(draw, 120));
        draw();
    }

    async function folders() {
        const source = parts[1];
        if (source === undefined) {
            const payload = await api.get("folders");
            if (!alive()) {
                return;
            }
            content.replaceChildren(payload.sources.length ? grid(payload.sources.map((entry) => {
                const card = button(null, "mu-folder-card", () => go(`library/folders/${entry.index}`));
                card.append(icon("library", 28), el("strong", null, entry.name), el("span", null, entry.configured ? "Music folder" : "Previously scanned"));
                return card;
            })) : emptyState("No folders indexed yet", "Add a music folder in Settings and scan it."));
            return;
        }
        const path = parts.slice(2).map(encode).join("/");
        const listing = await api.get(`folders/${encode(source)}${path ? `/${path}` : ""}`);
        if (!alive()) {
            return;
        }
        const crumbs = el("div", "mu-crumbs");
        crumbs.append(link("Folders", "library/folders"));
        const trail = [];
        crumbs.append(" / ", link(listing.source === Number(source) && !listing.path ? listing.name : "…", `library/folders/${source}`));
        for (const part of parts.slice(2)) {
            trail.push(encode(part));
            crumbs.append(" / ", link(part, `library/folders/${source}/${trail.join("/")}`));
        }
        const blocks = [crumbs];
        if (listing.folders.length) {
            blocks.push(grid(listing.folders.map((folder) => {
                const card = button(null, "mu-folder-card", () => go(`library/folders/${source}/${folder.path.split("/").map(encode).join("/")}`));
                card.append(icon("library", 22), el("strong", null, folder.name), el("span", null, plural(folder.tracks, "song")));
                return card;
            })));
        }
        if (listing.tracks.length) {
            blocks.push(el("div", "mu-hero-actions", null));
            blocks[blocks.length - 1].append(...playButtons(async () => listing.tracks, `folder:${source}-${listing.path.replace(/\//g, "-")}`));
            blocks.push(trackList(listing.tracks, { art: true, context: `folder:${source}` }));
        }
        content.replaceChildren(...blocks);
    }

    async function genres() {
        tools.append(filter);
        const payload = await api.get("genres");
        if (!alive()) {
            return;
        }
        const draw = () => {
            const text = filter.value.trim().toLowerCase();
            const shown = payload.genres.filter((genre) => matches(genre.name, text));
            const tiles = el("div", "mu-genre-grid");
            shown.forEach((genre, index) => {
                const tile = button(null, `mu-genre-tile mu-hue-${index % 8}`, () => go(`genre/${encode(genre.name)}`));
                tile.append(el("strong", null, genre.name), el("span", null, `${plural(genre.tracks, "song")} · ${plural(genre.albums, "album")}`));
                tiles.append(tile);
            });
            content.replaceChildren(shown.length ? tiles : emptyState("No genres", "Genres come from your files' tags."));
        };
        filter.addEventListener("input", draw);
        draw();
    }
}
