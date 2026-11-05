// What a Satellite's own page may add to the shared player: a track menu, adding to its
// playlists, and links into its own views (a track's album and artist, its library).
// Registered by that page when it loads; until then the player simply offers less.
// No entry is looked up by Satellite name.
import * as session from "./session.js";

const extensions = {};

/** Merges hooks: {trackMenu(track, anchor, extras), addToPlaylist(tracks), albumHref(id),
 * artistHref(id), openAlbum(id), openArtist(id), openLibrary()}. */
export function setExtensions(hooks) {
    Object.assign(extensions, hooks);
    session.emit("extensions", extensions);
}

export function extension(name) {
    return extensions[name] || null;
}
