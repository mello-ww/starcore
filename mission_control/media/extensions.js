// What the shared player adds for the Satellite it plays from: a track menu and links into
// its views (a track's album and artist, its library). The host builds these hooks from the
// provider's document's `audio` section (UI contract 1.2, see document.js) and sets them with
// setDocumentExtensions; nothing is looked up by Satellite name. Without them, the player
// simply offers less.
import * as session from "./session.js";

let derived = {};

/** The hooks built from the provider's document: {menuEntries(track), trackMenu,
 * openAlbum(id, track), openArtist(id, track), openLibrary}. Replaces the previous set. */
export function setDocumentExtensions(hooks) {
    derived = { ...(hooks || {}) };
    session.emit("extensions", derived);
}

export function extension(name) {
    return derived[name] || null;
}
