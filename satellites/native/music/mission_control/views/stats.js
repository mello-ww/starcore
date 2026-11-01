import * as api from "../api.js";
import { encode, go } from "../router.js";
import { artwork } from "../ui/artwork.js";
import { button, el, emptyState, plural, size } from "../ui/dom.js";
import { link } from "../ui/lists.js";
import { player } from "../player/player.js";

const RANGES = [[7, "Last 7 days"], [30, "Last 30 days"], [365, "Last year"], [0, "All time"]];

function bars(values, labels) {
    const node = el("div", "mu-bars");
    const max = Math.max(1, ...values);
    values.forEach((value, index) => {
        const bar = el("div", "mu-bar-col");
        const fill = el("span", "mu-bar-fill");
        fill.style.height = `${(value / max) * 100}%`;
        bar.title = `${labels[index]}: ${value}`;
        bar.append(fill, el("small", null, index % 3 === 0 ? labels[index] : ""));
        node.append(bar);
    });
    return node;
}

function ranking(title, items, render) {
    const section = el("section", "mu-rank");
    section.append(el("h3", null, title));
    const list = el("ol", "mu-rank-list");
    for (const item of items) {
        const row = el("li");
        render(row, item);
        list.append(row);
    }
    section.append(items.length ? list : el("p", "mu-hint", "Nothing yet"));
    return section;
}

function tiles(entries) {
    const node = el("dl", "mu-tiles");
    for (const [label, value] of entries) {
        const tile = el("div", "mu-tile");
        tile.append(el("dt", null, label), el("dd", null, String(value)));
        node.append(tile);
    }
    return node;
}

async function statsView(node, params, alive) {
    const days = Number(params.get("days") ?? 30);
    const tabs = el("div", "mu-tabs");
    for (const [value, label] of RANGES) {
        tabs.append(button(label, `mu-tab${value === days ? " active" : ""}`, () => go(`stats?days=${value}`)));
    }
    const year = new Date().getFullYear();
    tabs.append(button(`${year} Wrapped`, "mu-tab mu-tab-accent", () => go(`wrapped/${year}`)));
    node.append(el("h1", "mu-page-title", "Your listening"), tabs);
    const stats = await api.get(`stats${api.query({ days, limit: 10 })}`);
    if (!alive()) {
        return;
    }
    const library = stats.library;
    node.append(tiles([["Minutes listened", stats.minutes], ["Plays", stats.plays], ["Different songs", stats.distinct_tracks],
        ["Library songs", library.tracks], ["Lossless", library.lossless], ["Hi-Res", library.hires], ["Library size", size(library.size_bytes)]]));
    if (!stats.plays) {
        node.append(emptyState("No plays in this period", "Statistics are counted only on this server, from songs you play past the halfway mark (or four minutes)."));
        return;
    }
    const grid = el("div", "mu-rank-grid");
    grid.append(
        ranking("Top songs", stats.top_tracks, (row, entry) => {
            row.append(artwork(entry.track.album_id, 96, "mu-art mu-rank-art"), el("span", null, entry.track.title), el("small", null, plural(entry.plays, "play")));
            row.addEventListener("dblclick", () => player().play([entry.track], 0, "library:stats"));
        }),
        ranking("Top artists", stats.top_artists, (row, entry) => row.append(link(entry.name || "Unknown", `artist/${encode(entry.id)}`), el("small", null, `${entry.minutes} min`))),
        ranking("Top albums", stats.top_albums, (row, entry) => row.append(artwork(entry.id, 96, "mu-art mu-rank-art"), link(entry.album || "Unknown", `album/${encode(entry.id)}`), el("small", null, plural(entry.plays, "play")))),
        ranking("Top genres", stats.top_genres, (row, entry) => row.append(link(entry.name, `genre/${encode(entry.name)}`), el("small", null, plural(entry.plays, "play")))),
    );
    const hours = el("section", "mu-shelf");
    hours.append(el("h3", null, "When you listen"), bars(stats.by_hour, stats.by_hour.map((_, hour) => `${hour}:00`)));
    node.append(grid, hours);
}

async function wrappedView(node, parts, alive) {
    const year = Number(parts[0]) || new Date().getFullYear();
    const wrapped = await api.get(`wrapped?year=${year}`);
    if (!alive()) {
        return;
    }
    const nav = el("div", "mu-tabs");
    for (const candidate of [year - 1, year, year + 1].filter((value) => value <= new Date().getFullYear())) {
        nav.append(button(String(candidate), `mu-tab${candidate === year ? " active" : ""}`, () => go(`wrapped/${candidate}`)));
    }
    const hero = el("section", "mu-wrapped-hero");
    hero.append(el("span", "mu-hero-kind", "StarCore Wrapped"), el("h1", null, String(year)), el("p", null, wrapped.personality));
    node.append(nav, hero);
    if (!wrapped.plays) {
        node.append(emptyState(`No listening recorded in ${year}`, "Wrapped is built from your own history on this server."));
        return;
    }
    node.append(tiles([["Minutes", wrapped.minutes], ["Plays", wrapped.plays], ["Songs", wrapped.distinct_tracks], ["Listening days", wrapped.listening_days],
        ["Longest streak", plural(wrapped.longest_streak, "day")], ["New artists", wrapped.new_artist_count],
        ["Peak hour", wrapped.peak_hour !== null ? `${wrapped.peak_hour}:00` : "—"], ["Biggest day", wrapped.busiest_day ? `${wrapped.busiest_day.day} (${wrapped.busiest_day.minutes} min)` : "—"]]));
    const grid = el("div", "mu-rank-grid");
    grid.append(
        ranking("Your top songs", wrapped.top_tracks, (row, entry) => row.append(artwork(entry.track.album_id, 96, "mu-art mu-rank-art"), el("span", null, entry.track.title), el("small", null, plural(entry.plays, "play")))),
        ranking("Your top artists", wrapped.top_artists, (row, entry) => row.append(link(entry.name || "Unknown", `artist/${encode(entry.id)}`), el("small", null, `${entry.minutes} min`))),
        ranking("Your top genres", wrapped.top_genres, (row, entry) => row.append(el("span", null, entry.name), el("small", null, plural(entry.plays, "play")))),
        ranking("Artists you discovered", wrapped.new_artists, (row, entry) => row.append(link(entry.name, `artist/${encode(entry.id)}`), el("small", null, entry.first_play.slice(0, 10)))),
    );
    node.append(grid);
    if (wrapped.top_tracks.length) {
        node.append(button(`Play your top songs of ${year}`, "button button-primary", () => player().play(wrapped.top_tracks.map((entry) => entry.track), 0, `mix:wrapped-${year}`)));
    }
}

export async function render({ node, view, parts, params, alive }) {
    if (view === "wrapped") {
        return wrappedView(node, parts, alive);
    }
    return statsView(node, params, alive);
}
