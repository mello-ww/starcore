// What the audio host adds to its player from the document of the Satellite it plays from
// (UI contract 1.2, the document's `audio`, docs/media-audio.md): menu entries after the host's
// own in More, the title's and artist's links, and a way to the Satellite's pages, each run
// with the playing track as $. and no page around it. A navigate opens that page of the
// Satellite's shared interface wherever the player is. Without `audio`, nothing is added.
//
// audioHooks and actionRunner are the rules, kept free of the page so they are tested on their
// own; watchDocument wires them to Mission Control.
import {
    checkDocument, isSafeRoute, isVisible, locateProvider, openedSection, resolve, resolveTemplate,
} from "../ui/contract.js";
import { runChoose } from "../ui/choose.js";
import { setDocumentExtensions } from "./extensions.js";
import * as session from "./session.js";

const UI_STYLESHEET = "/ui/ui.css";

function refused() {
    return new Error("That action points outside its Satellite and was refused.");
}

/** "album?id=3", the section a navigate opens. */
export function sectionFor(page, params) {
    const query = new URLSearchParams(params || {}).toString();
    return query ? `${page}?${query}` : page;
}

/**
 * Runs one of the `audio` section's actions for a track. deps:
 *  - open(section): opens a page of the Satellite's shared interface;
 *  - play(tracks, options), playSearch(text): the host's own;
 *  - load(route), post(route, body): the Satellite's routes, rejecting with its error;
 *  - choose(options), confirm(text): the choose dialog and a question;
 *  - reload(capability): what the client keeps of that capability, read again;
 *  - notify(message, kind);
 *  - locate(path): opens the folder holding a path in whichever Satellite browses files
 *    (change 18), resolving with whether it opened.
 * Resolves with whether it ran.
 */
export function actionRunner(deps) {
    return async function run(action, track) {
        if (!action || typeof action !== "object") {
            return false;
        }
        const bindings = { data: track || {} };
        try {
            if (action.navigate) {
                deps.open(sectionFor(action.navigate, resolve(action.params || {}, bindings)));
                return true;
            }
            if (action.play) {
                return await play(action.play, bindings, deps);
            }
            if (action.locate !== undefined) {
                return await locate(action, bindings, deps);
            }
            let result;
            if (action.choose) {
                const outcome = await runChoose(action, bindings, {
                    load: deps.load,
                    choose: deps.choose,
                    request: deps.post,
                    confirm: deps.confirm,
                });
                if (!outcome) {
                    return false;  // cancelled: nothing more runs
                }
                result = outcome.result;
            } else if (action.route !== undefined) {
                if (action.confirm && !deps.confirm(String(resolve(action.confirm, bindings)))) {
                    return false;
                }
                const route = resolveTemplate(action.route, bindings);
                if (!isSafeRoute(route)) {
                    throw refused();
                }
                result = action.method === "GET"
                    ? await deps.load(route)
                    : await deps.post(route, action.body !== undefined ? resolve(action.body, bindings) : {});
            } else {
                return false;
            }
            if (result && typeof result.message === "string") {
                deps.notify(result.message, "info");
            }
            if (typeof action.reloads === "string") {
                await deps.reload(action.reloads);
            }
            return true;
        } catch (error) {
            deps.notify((error && error.payload && error.payload.message) || (error && error.message) || "That didn't work.", "error");
            return false;
        }
    };
}

// change 18: the folder holding the track's file, in whichever Satellite browses files. The
// playing track keeps no path, so `route` (the Satellite's own, read with the track) answers
// the $. the path is read from.
async function locate(action, bindings, deps) {
    let from = bindings;
    if (action.route !== undefined) {
        const route = resolveTemplate(action.route, bindings);
        if (!route || !isSafeRoute(route)) {
            throw refused();
        }
        from = { data: (await deps.load(route)) || {} };
    }
    const path = resolve(action.locate, from);
    if (typeof deps.locate !== "function") {
        deps.notify("That isn't available in Mission Control.", "error");
        return false;
    }
    if (typeof path !== "string" || !path) {
        deps.notify("That file isn't in a folder you can browse.", "error");
        return false;
    }
    return deps.locate(path);
}

async function play(spec, bindings, deps) {
    if (spec.search !== undefined) {
        const found = await deps.playSearch(String(resolve(spec.search, bindings) ?? ""));
        if (!found) {
            deps.notify("Nothing to play was found.", "error");
        }
        return found > 0;
    }
    let tracks;
    let page = null;
    let context = spec.context !== undefined ? resolve(spec.context, bindings) : null;
    if (spec.route !== undefined) {
        const route = resolveTemplate(spec.route, bindings);
        if (!route || !isSafeRoute(route)) {
            throw refused();
        }
        const answer = await deps.load(route);
        tracks = answer && answer.tracks;
        if (spec.context === undefined && answer && typeof answer.context === "string") {
            context = answer.context;
        }
        const joiner = route.includes("?") ? "&" : "?";
        page = { answer, load: (params) => deps.load(`${route}${joiner}${new URLSearchParams(params)}`) };
    } else {
        tracks = resolve(spec.tracks, bindings);
    }
    const played = await deps.play(tracks, {
        start: spec.start !== undefined ? resolve(spec.start, bindings) : null,
        shuffle: spec.shuffle === true,
        queue: spec.queue,
        context,
        page,
    });
    if (!played) {
        deps.notify("There is nothing to play here.", "error");
    }
    return played > 0;
}

/**
 * The player's hooks from a document's `audio` (see extensions.js), or {} without one.
 * `run(action, track)` runs an action; `menu(items, anchor)` draws a menu; `current()` is
 * the playing track; `playNext(tracks)` is the host's own entry in a track's menu.
 */
export function audioHooks(audio, { run, menu, current, playNext }) {
    if (!audio || typeof audio !== "object") {
        return {};
    }
    const hooks = {};
    const entries = Array.isArray(audio.menu) ? audio.menu : [];
    if (entries.length) {
        hooks.menuEntries = (track) => entries
            .filter((entry) => entry.visible === undefined || isVisible(resolve(entry.visible, { data: track || {} })))
            .map((entry) => ({ label: entry.label, icon: entry.icon || null, action: () => run(entry.action, track) }));
        hooks.trackMenu = (track, anchor, extras = []) => {
            const own = [{ label: "Play next", action: () => playNext([track]) }];
            const added = hooks.menuEntries(track);
            menu([...own, ...(added.length ? ["-", ...added] : []), ...(extras.length ? ["-", ...extras] : [])], anchor);
        };
    }
    // the title's and artist's links: the id the player shows (one of several artists, say)
    // stands in for the track's own
    if (audio.album) {
        hooks.openAlbum = (id, track) => run(audio.album, { ...(track || current() || {}), album_id: id });
    }
    if (audio.artist) {
        hooks.openArtist = (id, track) => run(audio.artist, { ...(track || current() || {}), artist_id: id });
    }
    if (audio.library && audio.library.action) {
        hooks.openLibrary = { label: audio.library.label, action: () => run(audio.library.action, current() || {}) };
    }
    return hooks;
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, { headers: { Accept: "application/json", ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error((payload && payload.error) || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

function loadUiStylesheet() {
    if (!document.querySelector(`link[href="${UI_STYLESHEET}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = UI_STYLESHEET;
        document.head.appendChild(link);
    }
}

/** Reads the provider's document once the host has started and sets the player's hooks from
 * its `audio`. A document that can't be read, or that is invalid, adds nothing. */
export async function watchDocument(satellite, { player, menu, handOver, playSearch, closeFullscreen }) {
    const base = `/api/satellites/${encodeURIComponent(satellite)}`;
    let payload;
    try {
        payload = await requestJson(`${base}/ui`);
    } catch {
        return;
    }
    const doc = payload && payload.document;
    if (!doc || !doc.audio || checkDocument(doc)) {
        return;
    }
    const load = (route) => requestJson(`${base}/${route}`);
    const post = (route, body) => requestJson(`${base}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const run = actionRunner({
        open: (section) => {
            closeFullscreen();
            window.dispatchEvent(new CustomEvent("starcore:open-shared", { detail: { satellite, section } }));
        },
        play: (tracks, options) => handOver(player(), tracks, options),
        playSearch,
        load,
        post,
        choose: async (options) => {
            loadUiStylesheet();
            const { openChooser } = await import("../ui/choose.js");
            return openChooser({
                ...options,
                frame: (route) => {
                    const image = document.createElement("img");
                    image.className = "ui-media-thumb ui-choose-thumb";
                    image.loading = "lazy";
                    image.alt = "";
                    image.src = `${base}/${route}`;
                    return image;
                },
            });
        },
        confirm: (question) => window.confirm(question),
        reload: (capability) => (capability === "audio.session" ? session.reload() : null),
        notify: (message, kind) => session.toast(message, kind),
        locate: async (path) => {
            const catalog = await requestJson("/api/catalog").catch(() => null);
            const browser = locateProvider(catalog && catalog.capabilities);
            if (!browser) {
                throw new Error("That isn't available in Mission Control.");
            }
            const answer = await requestJson(
                `/api/satellites/${encodeURIComponent(browser.satellite)}/${browser.operations.locate}?${new URLSearchParams({ path })}`);
            const section = openedSection(answer);
            if (!section) {
                throw new Error("That isn't available in Mission Control.");
            }
            closeFullscreen();
            window.dispatchEvent(new CustomEvent("starcore:open-shared", { detail: { satellite: browser.satellite, section } }));
            return true;
        },
    });
    setDocumentExtensions(audioHooks(doc.audio, {
        run,
        menu,
        current: () => player().current,
        playNext: (tracks) => player().playNext(tracks),
    }));
}
