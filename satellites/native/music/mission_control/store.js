import * as api from "./api.js";

const listeners = new Map();

export const state = {
    preferences: null,
    favorites: { track: new Set(), album: new Set(), artist: new Set(), playlist: new Set() },
    playlists: [],
    pins: [],
    summary: null,
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

export function load() {
    if (!state.ready) {
        state.ready = Promise.all([
            api.get("preferences").then((prefs) => { state.preferences = prefs; }),
            refreshFavorites(),
            refreshPlaylists(),
            api.get("pins").then((payload) => { state.pins = payload.pins; }),
        ]).catch((error) => {
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
    state.preferences = { ...(state.preferences || {}), ...changes };
    emit("preferences", state.preferences);
    const saved = await api.post("preferences", changes);
    state.preferences = saved;
    emit("preferences", saved);
    return saved;
}

function applyFavorites(ids) {
    for (const kind of Object.keys(state.favorites)) {
        state.favorites[kind] = new Set(ids[kind] || []);
    }
    emit("favorites", state.favorites);
}

export async function refreshFavorites() {
    const payload = await api.get("favorites");
    applyFavorites(payload.ids);
}

export function isLiked(kind, id) {
    return state.favorites[kind] ? state.favorites[kind].has(id) : false;
}

export async function setLiked(kind, ids, liked) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
        state.favorites[kind][liked ? "add" : "delete"](id);
    }
    emit("favorites", state.favorites);
    const payload = await api.post("favorites", { kind, ids: list, liked });
    applyFavorites(payload.ids);
}

export function toggleLiked(kind, id) {
    return setLiked(kind, id, !isLiked(kind, id));
}

export async function refreshPlaylists() {
    const payload = await api.get("playlists");
    state.playlists = payload.playlists;
    emit("playlists", state.playlists);
    return state.playlists;
}

export async function setPinned(kind, id, pinned) {
    const payload = await api.post("pins", { kind, id, pinned });
    state.pins = payload.pins;
    emit("pins", state.pins);
    await refreshPlaylists();
}

export function isPinned(kind, id) {
    return state.pins.some((pin) => pin.kind === kind && pin.id === id);
}

export function toast(message, kind = "info") {
    emit("toast", { message, kind });
}
