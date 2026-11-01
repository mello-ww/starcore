import * as api from "../api.js";
import { encode, go } from "../router.js";
import { artwork } from "../ui/artwork.js";
import { button, debounce, el, emptyState, iconButton } from "../ui/dom.js";
import { albumCard, artistCard, playlistCard, shelf, trackList } from "../ui/lists.js";
import { player } from "../player/player.js";

const QUALITIES = [["", "Any quality"], ["lossless", "Lossless"], ["hires", "Hi-Res"], ["lossy", "Lossy"]];

export async function render({ node, params, alive }) {
    const bar = el("div", "mu-searchbar");
    const input = el("input", "mu-input mu-search-input");
    input.type = "search";
    input.placeholder = "What do you want to listen to?";
    input.setAttribute("aria-label", "Search your library");
    input.autocomplete = "off";
    input.value = params.get("q") || "";
    const genre = el("select", "mu-select");
    genre.setAttribute("aria-label", "Genre");
    genre.append(new Option("Any genre", ""));
    const quality = el("select", "mu-select");
    quality.setAttribute("aria-label", "Quality");
    for (const [value, label] of QUALITIES) {
        quality.append(new Option(label, value));
    }
    const suggestions = el("div", "mu-suggestions");
    suggestions.hidden = true;
    const field = el("div", "mu-search-field");
    field.append(input, suggestions);
    bar.append(field, genre, quality);
    const results = el("div", "mu-search-results");
    node.append(bar, results);
    input.focus();

    api.get("genres").then(({ genres }) => {
        for (const entry of genres) {
            genre.append(new Option(`${entry.name} (${entry.tracks})`, entry.name));
        }
        genre.value = params.get("genre") || "";
    }).catch(() => {});

    let token = 0;
    async function search(remember = false) {
        const query = input.value.trim();
        const mine = ++token;
        if (!query) {
            await showBrowse();
            return;
        }
        const payload = await api.get(`search${api.query({ q: query, genre: genre.value, quality: quality.value, limit: 30 })}`).catch((error) => ({ error }));
        if (mine !== token || !alive()) {
            return;
        }
        if (payload.error) {
            results.replaceChildren(emptyState("Search failed", payload.error.message));
            return;
        }
        if (remember) {
            api.post("search/recent", { query }).catch(() => {});
        }
        renderResults(payload);
    }

    function renderResults(payload) {
        const blocks = [];
        if (payload.corrected) {
            blocks.push(el("p", "mu-hint", `No exact matches. Showing results for “${payload.corrected}”.`));
        }
        const total = payload.tracks.length + payload.albums.length + payload.artists.length + payload.playlists.length;
        if (!total && !payload.genres.length) {
            blocks.push(emptyState(`No results for “${payload.query}”`, "Check the spelling, try fewer words, or search for an artist, album or genre."));
            results.replaceChildren(...blocks);
            return;
        }
        const top = el("div", "mu-search-top");
        if (payload.top) {
            const best = el("section", "mu-top-result");
            best.append(el("h3", null, "Top result"));
            const item = payload.top.item;
            const card = el("div", "mu-top-card");
            if (payload.top.kind === "track") {
                card.append(artwork(item.album_id, 300, "mu-art"), el("h2", null, item.title), el("p", null, `Song · ${item.artist || item.album_artist || ""}`));
                card.append(iconButton("play", "Play", () => player().play([item], 0, `search:${slugOf(payload.query)}`), "mu-card-play mu-top-play"));
            } else if (payload.top.kind === "album") {
                card.append(artwork(item.id, 300, "mu-art"), el("h2", null, item.album), el("p", null, `Album · ${item.artist}`));
                card.addEventListener("click", () => go(`album/${encode(item.id)}`));
            } else {
                card.append(artwork(item.artwork, 300, "mu-art mu-art-round"), el("h2", null, item.name), el("p", null, "Artist"));
                card.addEventListener("click", () => go(`artist/${encode(item.id)}`));
            }
            best.append(card);
            top.append(best);
        }
        if (payload.tracks.length) {
            const songs = el("section", "mu-top-songs");
            songs.append(el("h3", null, "Songs"), trackList(payload.tracks.slice(0, 5), { art: true, album: false, context: `search:${slugOf(payload.query)}` }));
            top.append(songs);
        }
        blocks.push(top);
        if (payload.artists.length) {
            blocks.push(shelf("Artists", payload.artists.map((artist) => artistCard(artist, `${artist.tracks} songs`))));
        }
        if (payload.albums.length) {
            blocks.push(shelf("Albums", payload.albums.map((album) => albumCard(album))));
        }
        if (payload.playlists.length) {
            blocks.push(shelf("Playlists", payload.playlists.map((playlist) => playlistCard(playlist))));
        }
        if (payload.genres.length) {
            const chips = el("div", "mu-chips");
            for (const entry of payload.genres) {
                chips.append(button(entry.name, "mu-chip", () => go(`genre/${encode(entry.name)}`)));
            }
            const section = el("section", "mu-shelf");
            section.append(el("h3", null, "Genres"), chips);
            blocks.push(section);
        }
        if (payload.tracks.length > 5) {
            const section = el("section", "mu-shelf");
            section.append(el("h3", null, "All songs"), trackList(payload.tracks, { art: true, context: `search:${slugOf(payload.query)}` }));
            blocks.push(section);
        }
        results.replaceChildren(...blocks);
    }

    async function showBrowse() {
        const [recent, genres] = await Promise.all([
            api.get("search/recent").catch(() => ({ recent: [] })),
            api.get("genres").catch(() => ({ genres: [] })),
        ]);
        if (!alive() || input.value.trim()) {
            return;
        }
        const blocks = [];
        if (recent.recent.length) {
            const section = el("section", "mu-shelf");
            const head = el("div", "mu-shelf-head");
            head.append(el("h3", null, "Recent searches"), button("Clear", "mu-text-button", async () => {
                await api.post("search/recent", { clear: true });
                showBrowse();
            }));
            const chips = el("div", "mu-chips");
            for (const query of recent.recent) {
                chips.append(button(query, "mu-chip", () => {
                    input.value = query;
                    search(true);
                }));
            }
            section.append(head, chips);
            blocks.push(section);
        }
        if (genres.genres.length) {
            const section = el("section", "mu-shelf");
            section.append(el("h3", null, "Browse genres"));
            const tiles = el("div", "mu-genre-grid");
            genres.genres.slice(0, 40).forEach((entry, index) => {
                const tile = button(null, `mu-genre-tile mu-hue-${index % 8}`, () => go(`genre/${encode(entry.name)}`));
                tile.append(el("strong", null, entry.name), el("span", null, `${entry.tracks} songs`));
                tiles.append(tile);
            });
            section.append(tiles);
            blocks.push(section);
        }
        if (!blocks.length) {
            blocks.push(emptyState("Search your library", "Find songs, artists, albums, playlists and genres. Typos are forgiven."));
        }
        results.replaceChildren(...blocks);
    }

    const suggest = debounce(async () => {
        const query = input.value.trim();
        if (query.length < 2) {
            suggestions.hidden = true;
            return;
        }
        const payload = await api.get(`search/suggest${api.query({ q: query })}`).catch(() => ({ suggestions: [] }));
        if (!alive() || input.value.trim() !== query) {
            return;
        }
        suggestions.replaceChildren(...payload.suggestions.map((entry) => {
            const item = button(null, "mu-suggestion", () => {
                suggestions.hidden = true;
                input.value = entry.text;
                search(true);
            });
            item.append(el("span", null, entry.text), el("small", null, entry.subtitle ? `${entry.kind} · ${entry.subtitle}` : entry.kind));
            return item;
        }));
        suggestions.hidden = !payload.suggestions.length;
    }, 150);
    const live = debounce(() => search(false), 250);

    input.addEventListener("input", () => {
        live();
        suggest();
        const url = new URL(location.href);
        history.replaceState(null, "", url.hash.split("?")[0] + (input.value ? `?q=${encodeURIComponent(input.value)}` : ""));
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            suggestions.hidden = true;
            live.cancel();
            search(true);
        } else if (event.key === "Escape") {
            suggestions.hidden = true;
        }
    });
    input.addEventListener("blur", () => setTimeout(() => { suggestions.hidden = true; }, 200));
    genre.addEventListener("change", () => search(false));
    quality.addEventListener("change", () => search(false));
    await search(false);
    return () => {
        live.cancel();
        suggest.cancel();
    };
}

function slugOf(text) {
    return String(text).toLowerCase().replace(/[^\w]+/g, "-").slice(0, 60);
}
