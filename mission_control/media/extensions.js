// What the shared player adds for the Satellite it plays from: a track menu, adding to its
// playlists, and links into its views (a track's album and artist, its library). Two sources,
// neither looked up by Satellite name:
// - the provider's own page (page.js) registers its hooks while it is shown, and they win
//   then (setExtensions, clearExtensions);
// - otherwise the hooks the host builds from the provider's document's `audio` section
//   (UI contract 1.2, see document.js), set by setDocumentExtensions.
// Without either, the player simply offers less.
import * as session from "./session.js";

let own = null;
let derived = {};

/** The own page's hooks: {trackMenu(track, anchor, extras), addToPlaylist(tracks),
 * albumHref(id), artistHref(id), openAlbum(id), openArtist(id), openLibrary {label, action},
 * focusSearch()}. Merged with what it registered before, until clearExtensions. */
export function setExtensions(hooks) {
    own = { ...(own || {}), ...hooks };
    session.emit("extensions", own);
}

/** The own page is gone: the document's hooks, if any, apply again. */
export function clearExtensions() {
    own = null;
    session.emit("extensions", derived);
}

/** The hooks built from the provider's document: {menuEntries(track), trackMenu,
 * openAlbum(id, track), openArtist(id, track), openLibrary}. Replaces the previous set. */
export function setDocumentExtensions(hooks) {
    derived = { ...(hooks || {}) };
    if (!own) {
        session.emit("extensions", derived);
    }
}

export function extension(name) {
    const hooks = own || derived;
    return hooks[name] || null;
}
