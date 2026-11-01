import * as store from "../store.js";
import { encode, go } from "../router.js";
import { player } from "../player/player.js";
import { albumMenu, trackMenu } from "./actions.js";
import { artwork, mosaic } from "./artwork.js";
import { button, duration, el, icon, iconButton, longDuration, plural } from "./dom.js";

function markPlaying() {
    const current = player().engine.track;
    const playing = player().engine.playing;
    for (const row of document.querySelectorAll(".mu-track[data-track-id]")) {
        const active = Boolean(current) && row.dataset.trackId === current.id;
        row.classList.toggle("active", active);
        row.classList.toggle("paused", active && !playing);
    }
}

let watching = false;

function watch() {
    if (watching) {
        return;
    }
    watching = true;
    player().on("track", markPlaying);
    player().on("state", markPlaying);
    store.on("favorites", () => {
        for (const node of document.querySelectorAll("[data-like-kind]")) {
            const liked = store.isLiked(node.dataset.likeKind, node.dataset.likeId);
            node.classList.toggle("liked", liked);
            node.setAttribute("aria-pressed", String(liked));
        }
    });
}

export function likeButton(kind, id, label = "Like") {
    const node = iconButton("heart", label, () => store.toggleLiked(kind, id).catch((error) => store.toast(error.message, "error")), "mu-icon-button mu-like");
    node.dataset.likeKind = kind;
    node.dataset.likeId = id;
    const liked = store.isLiked(kind, id);
    node.classList.toggle("liked", liked);
    node.setAttribute("aria-pressed", String(liked));
    return node;
}

export function link(text, path, className = "mu-link") {
    const node = el("a", className, text);
    node.href = `#`;
    node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        go(path);
    });
    return node;
}

export function artistLinks(track) {
    const wrap = el("span", "mu-artists");
    const artists = track.artists && track.artists.length ? track.artists : [{ id: track.artist_id, name: track.artist || track.album_artist || "Unknown artist" }];
    artists.forEach((artist, index) => {
        if (index) {
            wrap.append(", ");
        }
        wrap.append(artist.id ? link(artist.name, `artist/${encode(artist.id)}`) : artist.name);
    });
    return wrap;
}

export function qualityBadge(quality) {
    if (!quality || !(quality.lossless || quality.hires)) {
        return null;
    }
    const node = el("span", `mu-badge ${quality.hires ? "mu-badge-hires" : "mu-badge-lossless"}`, quality.hires ? "Hi-Res" : "Lossless");
    node.title = quality.label;
    return node;
}

// Builds the first `size` items now and the rest as the end of the list scrolls into view,
// so a library of thousands never puts thousands of nodes on the page at once.
export function progressive(container, items, build, size = 120) {
    let next = 0;
    let sentinel = null;
    let observer = null;
    const margin = 600;
    const near = () => sentinel !== null && sentinel.getBoundingClientRect().top < window.innerHeight + margin;
    // scroll events back the observer up: some embedded views never deliver intersections
    const onScroll = () => {
        if (!container.isConnected) {
            stop();
        } else if (near()) {
            more();
        }
    };
    const stop = () => {
        observer?.disconnect();
        document.removeEventListener("scroll", onScroll, true);
    };
    const more = () => {
        sentinel?.remove();
        sentinel = null;
        const end = Math.min(next + size, items.length);
        for (; next < end; next += 1) {
            build(items[next], next);
        }
        if (next >= items.length) {
            stop();
            return;
        }
        sentinel = el("div", "mu-more");
        sentinel.setAttribute("aria-hidden", "true");
        container.appendChild(sentinel);
        observer = observer || new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                more();
            }
        }, { rootMargin: `${margin}px` });
        observer.observe(sentinel);
    };
    more();
    if (next < items.length) {
        document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    }
}

// options: context, numbered, art, album, reason, onReorder(from, to), extras(track, index) -> menu items, onRemove
export function trackList(tracks, options = {}) {
    watch();
    const list = el("div", "mu-tracklist");
    list.setAttribute("role", "list");
    const playable = tracks.filter((track) => !track.missing);
    let dragged = null;

    const build = (track, index) => {
        const row = el("div", `mu-track${track.missing ? " missing" : ""}`);
        row.setAttribute("role", "listitem");
        row.tabIndex = 0;
        if (track.id) {
            row.dataset.trackId = track.id;
        }
        const start = () => {
            if (track.missing) {
                store.toast("This file is no longer in your library");
                return;
            }
            const position = playable.indexOf(track);
            player().play(playable, Math.max(position, 0), options.context);
        };
        const number = el("span", "mu-track-number");
        number.append(el("span", "mu-track-index", options.numbered === "track" ? String(track.track || "") : String(index + 1)));
        const playIcon = iconButton("play", `Play ${track.title || ""}`, start, "mu-track-play");
        number.append(playIcon, el("span", "mu-eq-bars"));
        row.append(number);

        if (options.onReorder) {
            const handle = el("span", "mu-drag-handle");
            handle.appendChild(icon("drag", 16));
            handle.title = "Drag to reorder";
            row.draggable = true;
            row.prepend(handle);
            row.addEventListener("dragstart", (event) => {
                dragged = index;
                row.classList.add("dragging");
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
            });
            row.addEventListener("dragend", () => row.classList.remove("dragging"));
            row.addEventListener("dragover", (event) => {
                event.preventDefault();
                row.classList.add("drop-target");
            });
            row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
            row.addEventListener("drop", (event) => {
                event.preventDefault();
                row.classList.remove("drop-target");
                if (dragged !== null && dragged !== index) {
                    options.onReorder(dragged, index);
                }
                dragged = null;
            });
        }

        if (options.art) {
            row.append(artwork(track.album_id, 96, "mu-art mu-track-art"));
        }
        const main = el("div", "mu-track-main");
        const title = el("span", "mu-track-title", track.title || "Unavailable track");
        main.append(title);
        if (!track.missing) {
            const sub = el("span", "mu-track-sub");
            const badge = qualityBadge(track.quality);
            if (badge) {
                sub.append(badge);
            }
            sub.append(artistLinks(track));
            main.append(sub);
        }
        if (options.reason && track.reason) {
            main.append(el("span", "mu-track-reason", track.reason));
        }
        row.append(main);
        if (options.album !== false) {
            const album = el("span", "mu-track-album");
            if (track.album_id && !track.missing) {
                album.append(link(track.album || "Unknown album", `album/${encode(track.album_id)}`));
            }
            row.append(album);
        }
        const actions = el("span", "mu-track-actions");
        if (track.id && !track.missing) {
            actions.append(likeButton("track", track.id));
        }
        actions.append(el("span", "mu-track-duration", track.duration ? duration(track.duration) : ""));
        const more = iconButton("more", "More options", (event) => openMenu(event));
        actions.append(more);
        row.append(actions);

        const openMenu = (event) => {
            const extras = options.extras ? options.extras(track, index) : [];
            if (track.missing) {
                if (extras.length) {
                    import("./overlay.js").then(({ menu }) => menu(extras, event));
                }
                return;
            }
            trackMenu(track, event, extras);
        };
        row.addEventListener("dblclick", start);
        row.addEventListener("keydown", (event) => {
            if (event.target !== row) {
                return;
            }
            if (event.key === "Enter") {
                start();
            } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                openMenu(more);
            }
        });
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            openMenu(event);
        });
        list.appendChild(row);
    };
    progressive(list, tracks, build, 150);
    queueMicrotask(markPlaying);
    return list;
}

function card(art, title, subtitle, onOpen, onPlay, onMenu, round = false) {
    const node = el("div", `mu-card${round ? " mu-card-round" : ""}`);
    node.tabIndex = 0;
    node.setAttribute("role", "link");
    node.setAttribute("aria-label", title);
    const frame = el("div", "mu-card-art");
    frame.append(art);
    if (onPlay) {
        frame.append(iconButton("play", `Play ${title}`, onPlay, "mu-card-play"));
    }
    node.append(frame, el("div", "mu-card-title", title));
    if (subtitle) {
        node.append(el("div", "mu-card-sub", subtitle));
    }
    node.addEventListener("click", onOpen);
    node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target === node) {
            onOpen();
        }
    });
    if (onMenu) {
        node.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            onMenu(event);
        });
    }
    return node;
}

export function albumCard(album, subtitle) {
    const fetchTracks = async () => (await import("../api.js")).get(`albums/${encode(album.id)}`).then((detail) => detail.tracks);
    return card(artwork(album.artwork ? album.id : null, 300), album.album || "Unknown album",
        subtitle !== undefined ? subtitle : [album.artist, album.year, album.type && album.type !== "album" ? album.type.toUpperCase() : null].filter(Boolean).join(" · "),
        () => go(`album/${encode(album.id)}`),
        async () => player().play(await fetchTracks(), 0, `album:${album.id}`),
        (event) => albumMenu(album, event));
}

export function artistCard(artist, subtitle) {
    return card(artwork(artist.artwork, 300), artist.name, subtitle !== undefined ? subtitle : "Artist",
        () => go(`artist/${encode(artist.id)}`), null, null, true);
}

export function playlistCard(playlist) {
    return card(mosaic(playlist.mosaic, playlist.cover), playlist.name,
        `${playlist.smart ? "Smart playlist · " : ""}${plural(playlist.tracks || 0, "song")}`,
        () => go(`playlist/${encode(playlist.id)}`),
        async () => {
            const detail = await (await import("../api.js")).get(`playlists/${encode(playlist.id)}`);
            player().play(detail.tracks, 0, `playlist:${playlist.id}`);
        });
}

export function mixCard(mix) {
    const art = mosaic(mix.mosaic, null);
    art.classList.add("mu-mix-art");
    art.append(el("span", "mu-mix-label", mix.name));
    return card(art, mix.name, mix.description, () => go(`mix/${encode(mix.id)}`),
        async () => {
            const detail = await (await import("../api.js")).get(`mixes/${encode(mix.id)}`);
            player().play(detail.tracks, 0, `mix:${mix.id}`);
        });
}

export function shelf(title, items, options = {}) {
    const section = el("section", "mu-shelf");
    const head = el("div", "mu-shelf-head");
    head.append(el("h3", null, title));
    if (options.subtitle) {
        head.append(el("p", "mu-shelf-sub", options.subtitle));
    }
    if (options.more) {
        head.append(button("Show all", "mu-text-button", options.more));
    }
    const row = el("div", options.grid ? "mu-grid" : "mu-row");
    for (const item of items) {
        row.append(item);
    }
    section.append(head, row);
    return section;
}

export function grid(items, build) {
    const node = el("div", "mu-grid");
    if (build) {
        progressive(node, items, (item) => node.append(build(item)), 96);
        return node;
    }
    for (const item of items) {
        node.append(item);
    }
    return node;
}

export function header({ art, kind, title, meta, description, actions }) {
    const node = el("header", "mu-hero");
    const info = el("div", "mu-hero-info");
    if (kind) {
        info.append(el("span", "mu-hero-kind", kind));
    }
    info.append(el("h1", "mu-hero-title", title));
    if (description) {
        info.append(el("p", "mu-hero-description", description));
    }
    if (meta) {
        const line = el("div", "mu-hero-meta");
        for (const part of meta.filter(Boolean)) {
            line.append(typeof part === "string" ? el("span", null, part) : part);
        }
        info.append(line);
    }
    node.append(art, info);
    if (actions) {
        const bar = el("div", "mu-hero-actions");
        bar.append(...actions.filter(Boolean));
        node.append(bar);
    }
    return node;
}

export function playButtons(getTracks, context) {
    const play = button(null, "mu-play-big", async () => {
        const tracks = await getTracks();
        player().shuffle = false;
        player().play(tracks, 0, context);
    }, "Play");
    play.append(icon("play", 22));
    const shuffle = iconButton("shuffle", "Shuffle play", async () => player().shufflePlay(await getTracks(), context), "mu-icon-button mu-icon-large");
    return [play, shuffle];
}

export function totals(tracks) {
    const playable = tracks.filter((track) => !track.missing);
    return `${plural(playable.length, "song")}, ${longDuration(playable.reduce((sum, track) => sum + (track.duration || 0), 0))}`;
}
