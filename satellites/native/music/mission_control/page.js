import * as api from "./api.js";
import * as store from "./store.js";
import { current, encode, go, href, setSatellite } from "./router.js";
import { register } from "/media/theme.js";
import { setExtensions } from "/media/extensions.js";
import { start as startAudioHost } from "/media/host.js";
import { addToPlaylist, trackMenu } from "./ui/actions.js";
import { mosaic } from "./ui/artwork.js";
import { button, el, errorState, icon } from "/media/dom.js";
import "/media/overlay.js";

const VIEWS = {
    home: () => import("./views/home.js"),
    search: () => import("./views/search.js"),
    library: () => import("./views/library.js"),
    album: () => import("./views/album.js"),
    artist: () => import("./views/artist.js"),
    playlist: () => import("./views/playlist.js"),
    mix: () => import("./views/collections.js"),
    radio: () => import("./views/collections.js"),
    mood: () => import("./views/collections.js"),
    genre: () => import("./views/collections.js"),
    stats: () => import("./views/stats.js"),
    wrapped: () => import("./views/stats.js"),
    settings: () => import("./views/settings.js"),
};

const NAV = [["home", "Home", "home"], ["search", "Search", "search"], ["library", "Your Library", "library"], ["stats", "Stats", "stats"], ["settings", "Settings", "settings"]];

// What Music adds to Mission Control's shared player (docs/media-audio.md): its track menu,
// its playlists, and links into its own views. The player itself is the shell's.
function registerExtensions() {
    setExtensions({
        trackMenu,
        addToPlaylist,
        albumHref: (id) => href(`album/${encode(id)}`),
        artistHref: (id) => href(`artist/${encode(id)}`),
        openAlbum: (id) => go(`album/${encode(id)}`),
        openArtist: (id) => go(`artist/${encode(id)}`),
        openLibrary: { label: "Open Music", action: () => go("") },
        focusSearch: () => {
            if (!current()) {
                return;
            }
            const field = document.querySelector(".mu-search-input");
            if (field) {
                field.focus();
            } else {
                go("search");
            }
        },
    });
}

export function mount(context) {
    const { element, satellite, api: client } = context;
    api.setBase(client.url(""));
    setSatellite(satellite.name);
    store.setOwner(satellite.name);
    registerExtensions();
    // the shell normally started it already; a no-op then
    startAudioHost();

    const root = el("div", "mu-root");
    const unregister = register(root);
    const sidebar = el("nav", "mu-sidebar");
    sidebar.setAttribute("aria-label", "Music");
    const main = el("main", "mu-main");
    main.tabIndex = -1;
    root.append(sidebar, main);
    element.replaceChildren(root);
    // Music is a full-height app: its host view stops scrolling and Music's own content area scrolls
    const host = element.closest(".view");
    host?.classList.add("mu-host");

    const navButtons = new Map();
    const navList = el("div", "mu-nav");
    for (const [key, label, iconName] of NAV) {
        const item = button(null, "mu-nav-item", () => go(key === "home" ? "" : key));
        item.append(icon(iconName), el("span", null, label));
        navButtons.set(key, item);
        navList.append(item);
    }
    const shelf = el("div", "mu-nav-shelf");
    const shelfHead = el("div", "mu-nav-shelf-head");
    shelfHead.append(el("span", null, "Playlists"), button("+", "mu-icon-button mu-nav-add", async () => {
        const { createPlaylist } = await import("./views/playlist.js");
        createPlaylist();
    }, "Create playlist"));
    const shelfList = el("div", "mu-nav-playlists");
    shelf.append(shelfHead, shelfList);
    sidebar.append(navList, shelf);

    function renderShelf() {
        const pinned = new Set(store.state.pins.filter((pin) => pin.kind === "playlist").map((pin) => pin.id));
        const items = [];
        const liked = button(null, "mu-nav-playlist", () => go("library/liked"));
        const likedArt = el("div", "mu-art mu-liked-art");
        likedArt.append(icon("heart", 16));
        liked.append(likedArt, el("span", null, "Liked Songs"));
        items.push(liked);
        const sorted = [...store.state.playlists].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
        for (const playlist of sorted) {
            const entry = button(null, "mu-nav-playlist", () => go(`playlist/${encodeURIComponent(playlist.id)}`));
            entry.append(mosaic(playlist.mosaic, playlist.cover, "mu-art", 96), el("span", null, playlist.name));
            if (pinned.has(playlist.id)) {
                entry.append(icon("pin", 12));
            }
            entry.dataset.id = playlist.id;
            items.push(entry);
        }
        shelfList.replaceChildren(...items);
    }

    let token = 0;
    let disposeView = null;

    async function route() {
        const location = current();
        if (!location) {
            return;
        }
        const mine = ++token;
        for (const [key, node] of navButtons) {
            const active = key === location.view || (key === "stats" && location.view === "wrapped");
            node.classList.toggle("active", active);
            node.toggleAttribute("aria-current", active);
        }
        for (const node of shelfList.children) {
            node.classList.toggle("active", location.view === "playlist" && node.dataset.id === location.parts[0]);
        }
        if (disposeView) {
            disposeView();
            disposeView = null;
        }
        const loader = VIEWS[location.view];
        if (!loader) {
            go("");
            return;
        }
        main.replaceChildren(el("div", "mu-skeleton mu-skeleton-hero"));
        try {
            await store.load();
            const module = await loader();
            if (mine !== token) {
                return;
            }
            const view = el("div", "mu-view");
            main.replaceChildren(view);
            main.scrollTop = 0;
            const result = await module.render({
                node: view,
                view: location.view,
                parts: location.parts,
                params: location.params,
                alive: () => mine === token && view.isConnected,
            });
            if (typeof result === "function") {
                if (mine === token) {
                    disposeView = result;
                } else {
                    result();
                }
            }
        } catch (error) {
            if (mine === token) {
                main.replaceChildren(errorState(error, route));
            }
        }
    }

    const stops = [store.on("playlists", renderShelf), store.on("pins", renderShelf)];
    window.addEventListener("hashchange", route);
    store.load().then(renderShelf).catch(() => {});
    route();

    return () => {
        token += 1;
        window.removeEventListener("hashchange", route);
        stops.forEach((stop) => stop());
        if (disposeView) {
            disposeView();
        }
        host?.classList.remove("mu-host");
        unregister();
    };
}
