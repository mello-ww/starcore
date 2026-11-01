import * as api from "../api.js";
import { encode, go } from "../router.js";
import { mosaic } from "../ui/artwork.js";
import { button, el, emptyState, skeletonRows } from "../ui/dom.js";
import { albumCard, artistCard, mixCard, playlistCard, shelf, trackList } from "../ui/lists.js";

function contextCard(entry) {
    if (entry.kind === "album") {
        return albumCard(entry.item);
    }
    if (entry.kind === "playlist") {
        return playlistCard(entry.item);
    }
    if (entry.kind === "artist") {
        return artistCard(entry.item);
    }
    if (entry.kind === "mix") {
        const node = button(null, "mu-context-chip", () => go(`mix/${encode(entry.item.id)}`));
        node.append(mosaic([], null, "mu-art", 96), el("span", null, entry.item.id.replace(/-/g, " ")));
        return node;
    }
    return null;
}

function moodCard(mood) {
    const node = button(null, `mu-mood mu-mood-${mood.id}`, () => go(`mood/${encode(mood.id)}`));
    node.append(el("strong", null, mood.name), el("span", null, mood.genres.slice(0, 3).join(", ")));
    return node;
}

export async function render({ node, alive }) {
    const greeting = el("h1", "mu-greeting", " ");
    const sections = el("div", "mu-sections");
    sections.append(skeletonRows(3, "mu-skeleton-shelf"));
    node.append(greeting, sections);

    const [home, summary] = await Promise.all([
        api.get(`home${api.query({ hour: new Date().getHours() })}`),
        api.get("library").catch(() => null),
    ]);
    if (!alive()) {
        return;
    }
    greeting.textContent = home.greeting;
    if (summary && !summary.tracks) {
        sections.replaceChildren(emptyState("Your library is empty",
            summary.missing ? "The files you indexed before can't be found right now. Check that the music folder is available, then rescan."
                : "Add a music folder in Settings and scan it. Files stay where they are; StarCore only reads them.",
            button("Open settings", "button button-primary", () => go("settings"))));
        return;
    }
    const rendered = [];
    for (const section of home.sections) {
        let content = null;
        if (section.kind === "tracks") {
            const list = trackList(section.items.slice(0, 8), { art: true, album: false, reason: true, context: section.id === "liked" ? "liked:all" : `library:${section.id}` });
            const wrap = el("section", "mu-shelf");
            const head = el("div", "mu-shelf-head");
            head.append(el("h3", null, section.title));
            if (section.subtitle) {
                head.append(el("p", "mu-shelf-sub", section.subtitle));
            }
            if (section.id === "liked") {
                head.append(button("Show all", "mu-text-button", () => go("library/liked")));
            }
            wrap.append(head, list);
            content = wrap;
        } else if (section.kind === "albums") {
            content = shelf(section.title, section.items.map((album) => albumCard(album)), { subtitle: section.subtitle });
        } else if (section.kind === "artists") {
            content = shelf(section.title, section.items.map((artist) => artistCard(artist)), { subtitle: section.subtitle });
        } else if (section.kind === "mixes") {
            content = shelf(section.title, section.items.map((mix) => mixCard(mix)), { subtitle: section.subtitle });
        } else if (section.kind === "contexts") {
            const cards = section.items.map(contextCard).filter(Boolean);
            content = cards.length ? shelf(section.title, cards, { subtitle: section.subtitle }) : null;
        } else if (section.kind === "moods") {
            content = shelf(section.title, section.items.map(moodCard), { subtitle: section.subtitle });
            content.classList.add("mu-shelf-moods");
        }
        if (content) {
            content.dataset.section = section.id;
            rendered.push(content);
        }
    }
    if (!home.personalized) {
        const hint = el("p", "mu-hint", "Recommendations here are built only from your own library and listening, on this server. Play and like songs and they get better.");
        rendered.push(hint);
    }
    sections.replaceChildren(...rendered);
}
