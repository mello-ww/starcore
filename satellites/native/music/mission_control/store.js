// Music's page state: its playlists, pins and library summary, on the shared player's event
// bus (/media/session.js), so the player and Music's views hear the same events. Preferences
// and likes are the player's session when it plays from this Satellite (the usual case), so
// both always agree; otherwise they come from Music's own routes, as they always have.
import * as api from "./api.js";
import * as library from "/media/library.js";
import * as session from "/media/session.js";

let owner = "Music";
const own = { preferences: null, favorites: { track: new Set(), album: new Set(), artist: new Set(), playlist: new Set() } };

/** The page tells the store its Satellite's name when it mounts. */
export function setOwner(name) {
    owner = name;
}

function shared() {
    const provider = library.currentProvider();
    return Boolean(provider && provider.satellite.toLowerCase() === owner.toLowerCase());
}

export const state = {
    get preferences() {
        return shared() ? session.state.preferences : own.preferences;
    },
    get favorites() {
        return shared() ? session.state.favorites : own.favorites;
    },
    playlists: [],
    pins: [],
    summary: null,
    ready: null,
};

export const on = session.on;
export const emit = session.emit;
export const toast = session.toast;

export function load() {
    if (!state.ready) {
        state.ready = library.ready.then(() => Promise.all([
            shared() ? session.load() : loadOwn(),
            refreshPlaylists(),
            api.get("pins").then((payload) => { state.pins = payload.pins; }),
        ])).catch((error) => {
            state.ready = null;
            throw error;
        });
    }
    return state.ready;
}

async function loadOwn() {
    own.preferences = await api.get("preferences");
    emit("preferences", own.preferences);
    await refreshFavorites();
}

export function preference(key, fallback) {
    const prefs = state.preferences;
    return prefs && key in prefs ? prefs[key] : fallback;
}

export async function setPreferences(changes) {
    if (shared()) {
        return session.setPreferences(changes);
    }
    own.preferences = { ...(own.preferences || {}), ...changes };
    emit("preferences", own.preferences);
    own.preferences = await api.post("preferences", changes);
    emit("preferences", own.preferences);
    return own.preferences;
}

function applyFavorites(ids) {
    for (const kind of Object.keys(own.favorites)) {
        own.favorites[kind] = new Set(ids[kind] || []);
    }
    emit("favorites", own.favorites);
}

export async function refreshFavorites() {
    if (shared()) {
        return session.refreshFavorites();
    }
    applyFavorites((await api.get("favorites")).ids);
}

export function isLiked(kind, id) {
    const favorites = state.favorites;
    return favorites[kind] ? favorites[kind].has(id) : false;
}

export async function setLiked(kind, ids, liked) {
    if (shared()) {
        return session.setLiked(kind, ids, liked);
    }
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
        own.favorites[kind][liked ? "add" : "delete"](id);
    }
    emit("favorites", own.favorites);
    applyFavorites((await api.post("favorites", { kind, ids: list, liked })).ids);
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
