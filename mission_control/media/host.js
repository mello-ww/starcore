// Mission Control's audio host (the media.audio capability, docs/media-audio.md): started by
// the shell once signed in, so the player, its saved queue and the top-bar disc are there on
// every page, before any Satellite's page has loaded. It plays from whichever Satellite the
// catalog lists as the audio.library provider, and offers what that provider's audio.session
// declares (Connect only with `connect`, likes only with `favorites`...).
import * as library from "./library.js";
import { mountBar, toggleQueue } from "./bar.js";
import { connect } from "./connect.js";
import { extension } from "./extensions.js";
import { installKeys } from "./keys.js";
import { player } from "./player.js";
import "./overlay.js";

let started = null;

async function catalog() {
    try {
        const response = await fetch("/api/catalog", { headers: { Accept: "application/json" } });
        return response.ok ? (await response.json()).capabilities || {} : null;
    } catch (error) {
        return null;
    }
}

/** Plays what the audio.library provider finds for `text` (the UI contract's play action,
 * 1.2), from the start. Resolves with how many tracks it found; the search is the provider's
 * own operation, so this never names a Satellite. */
export async function playSearch(text) {
    await start();
    if (!library.currentProvider()) {
        throw new Error("There is no audio library to play from.");
    }
    const found = await library.get("operations", "search", library.query({ q: text }));
    const tracks = ((found && found.tracks) || []).filter((track) => track && track.id);
    if (tracks.length) {
        await player().play(tracks, 0, `search:${text}`);
    }
    return tracks.length;
}

/** Starts the host once; later calls return the same promise. Settles with the provider,
 * or null when the server offers no audio library (then nothing is drawn). */
export function start() {
    if (!started) {
        started = (async () => {
            const provider = library.resolveProvider(await catalog());
            library.setProvider(provider);
            if (!provider) {
                return null;
            }
            mountBar();
            const instance = player();
            instance.restore();
            if (library.offersSession("connect")) {
                connect(instance).start();
            }
            installKeys(() => {
                const focus = extension("focusSearch");
                if (focus) {
                    focus();
                }
            }, toggleQueue);
            return provider;
        })();
    }
    return started;
}
