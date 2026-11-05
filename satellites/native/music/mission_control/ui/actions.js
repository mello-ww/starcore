import * as api from "../api.js";
import * as store from "../store.js";
import { go, encode } from "../router.js";
import { player } from "/media/player.js";
import { button, el } from "/media/dom.js";
import { menu, modal, prompt } from "/media/overlay.js";
import { trackDetails } from "/media/details.js";

export { trackDetails };

export function startRadio(kind, id, label) {
    return api.get(`radio/${kind}/${encode(id)}`).then((station) => {
        if (!station.tracks.length) {
            store.toast("Not enough in your library to build that station yet");
            return;
        }
        player().play(station.tracks, 0, `radio:${kind}-${id}`);
        store.toast(`${label || station.name} started`);
    }).catch((error) => store.toast(error.message, "error"));
}

export async function addToPlaylist(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const playlists = (await store.refreshPlaylists().catch(() => store.state.playlists)).filter((playlist) => !playlist.smart);
    const body = el("div", "mu-choose");
    const choose = async (playlistId) => {
        try {
            let result = await api.post(`playlists/${playlistId}/add`, { tracks: list.map((track) => track.id) });
            if (result.duplicates.length && result.added < list.length) {
                const again = await new Promise((resolve) => {
                    modal("Already in this playlist", el("p", "mu-modal-text",
                        `${result.duplicates.length === 1 ? "This song is" : `${result.duplicates.length} of these songs are`} already in "${result.playlist.name}".`), [
                        { label: "Skip", action: () => resolve(false) },
                        { label: "Add anyway", primary: true, action: () => resolve(true) },
                    ]);
                });
                if (again) {
                    result = await api.post(`playlists/${playlistId}/add`, { tracks: result.duplicates, allow_duplicates: true });
                }
            }
            store.toast(`Added to ${result.playlist.name}`);
            store.refreshPlaylists();
        } catch (error) {
            store.toast(error.message, "error");
        }
    };
    const handle = modal(`Add ${list.length === 1 ? `"${list[0].title}"` : `${list.length} songs`} to playlist`, body, [{ label: "Close", action: () => {} }]);
    body.appendChild(button("+ New playlist", "mu-choose-item mu-choose-new", async () => {
        handle.close();
        const name = await prompt("New playlist", "Name");
        if (name) {
            const created = await api.post("playlists", { name, tracks: list.map((track) => track.id) });
            store.toast(`Created ${created.name}`);
            store.refreshPlaylists();
        }
    }));
    for (const playlist of playlists) {
        body.appendChild(button(`${playlist.name} · ${playlist.tracks}`, "mu-choose-item", () => {
            handle.close();
            choose(playlist.id);
        }));
    }
}

export async function showTrackInfo(track) {
    let full = track;
    try {
        full = await api.get(`tracks/${encode(track.id)}`);
    } catch (error) {
        // the payload we have is enough to show
    }
    const active = player().engine.track;
    modal(full.title || "Track", trackDetails(full, active && active.id === full.id ? player().engine.plan : null), [{ label: "Close", action: () => {} }]);
}

export function trackMenu(track, anchor, extras = []) {
    const liked = store.isLiked("track", track.id);
    menu([
        { label: "Play next", action: () => player().playNext([track]) },
        { label: "Add to queue", action: () => player().addToQueue([track]) },
        { label: "Add to playlist…", action: () => addToPlaylist([track]) },
        "-",
        { label: liked ? "Remove from Liked Songs" : "Save to Liked Songs", action: () => store.toggleLiked("track", track.id) },
        { label: "Start song radio", action: () => startRadio("track", track.id, `${track.title} radio`) },
        "-",
        track.album_id ? { label: "Go to album", action: () => go(`album/${encode(track.album_id)}`) } : null,
        track.artist_id ? { label: "Go to artist", action: () => go(`artist/${encode(track.artist_id)}`) } : null,
        { label: "Credits and file info", action: () => showTrackInfo(track) },
        ...(extras.length ? ["-", ...extras] : []),
    ], anchor);
}

export function albumMenu(album, anchor) {
    const load = () => api.get(`albums/${encode(album.id)}`);
    menu([
        { label: "Play", action: async () => { const detail = await load(); player().play(detail.tracks, 0, `album:${album.id}`); } },
        { label: "Play next", action: async () => player().playNext((await load()).tracks) },
        { label: "Add to queue", action: async () => player().addToQueue((await load()).tracks) },
        { label: "Add to playlist…", action: async () => addToPlaylist((await load()).tracks) },
        "-",
        { label: store.isLiked("album", album.id) ? "Remove from Your Library" : "Save to Your Library", action: () => store.toggleLiked("album", album.id) },
        { label: store.isPinned("album", album.id) ? "Unpin" : "Pin to Your Library", action: () => store.setPinned("album", album.id, !store.isPinned("album", album.id)).catch((error) => store.toast(error.message, "error")) },
        { label: "Start album radio", action: () => startRadio("album", album.id, `${album.album} radio`) },
        album.artist_id ? { label: "Go to artist", action: () => go(`artist/${encode(album.artist_id)}`) } : null,
    ], anchor);
}
