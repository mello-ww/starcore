// The shared player's state beyond the queue: the listener's preferences and likes from the
// provider's audio.session, notices ("toasts"), and the event bus the player, its UI and a
// Satellite's own page share. Without an optional session operation, its feature is absent:
// preferences stay at their defaults and likes stay empty, and nothing is sent.
import * as library from "./library.js";

const listeners = new Map();
const KINDS = ["track", "album", "artist", "playlist"];

export const state = {
    preferences: null,
    favorites: Object.fromEntries(KINDS.map((kind) => [kind, new Set()])),
    ready: null,
};

export function on(name, handler) {
    if (!listeners.has(name)) {
        listeners.set(name, new Set());
    }
    listeners.get(name).add(handler);
    return () => listeners.get(name).delete(handler);
}

export function emit(name, detail) {
    for (const handler of listeners.get(name) || []) {
        try {
            handler(detail);
        } catch (error) {
            console.error(error);
        }
    }
}

/** Preferences and likes, once the provider is known. Settles even when it has neither. */
export function load() {
    if (!state.ready) {
        state.ready = library.ready.then(() => Promise.all([
            library.offersSession("preferences")
                ? library.get("session", "preferences").then((prefs) => {
                    state.preferences = prefs;
                    emit("preferences", prefs);
                })
                : null,
            library.offersSession("favorites") ? refreshFavorites() : null,
        ])).catch((error) => {
            state.ready = null;
            throw error;
        });
    }
    return state.ready;
}

export function preference(key, fallback) {
    const prefs = state.preferences;
    return prefs && key in prefs ? prefs[key] : fallback;
}

export async function setPreferences(changes) {
    if (!library.offersSession("preferences")) {
        return state.preferences;
    }
    state.preferences = { ...(state.preferences || {}), ...changes };
    emit("preferences", state.preferences);
    const saved = await library.post("session", "preferences", "", changes);
    state.preferences = saved;
    emit("preferences", saved);
    return saved;
}

function applyFavorites(ids) {
    for (const kind of KINDS) {
        state.favorites[kind] = new Set((ids || {})[kind] || []);
    }
    emit("favorites", state.favorites);
}

export async function refreshFavorites() {
    if (!library.offersSession("favorites")) {
        return;
    }
    const payload = await library.get("session", "favorites");
    applyFavorites(payload.ids);
}

export function offersLikes() {
    return library.offersSession("favorites");
}

export function isLiked(kind, id) {
    return state.favorites[kind] ? state.favorites[kind].has(id) : false;
}

export async function setLiked(kind, ids, liked) {
    if (!library.offersSession("favorites")) {
        return;
    }
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
        state.favorites[kind][liked ? "add" : "delete"](id);
    }
    emit("favorites", state.favorites);
    const payload = await library.post("session", "favorites", "", { kind, ids: list, liked });
    applyFavorites(payload.ids);
}

export function toggleLiked(kind, id) {
    return setLiked(kind, id, !isLiked(kind, id));
}

export function toast(message, kind = "info") {
    emit("toast", { message, kind });
}
