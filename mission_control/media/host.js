// Mission Control's audio host (the media.audio capability, docs/media-audio.md): started by
// the shell once signed in, so the player, its saved queue and the top-bar disc are there on
// every page, before any Satellite's page has loaded. It plays from whichever Satellite the
// catalog lists as the audio.library provider, and offers what that provider's audio.session
// declares (Connect only with `connect`, likes only with `favorites`...).
import * as library from "./library.js";
import { mountBar, toggleQueue } from "./bar.js";
import { connect } from "./connect.js";
import { watchDocument } from "./document.js";
import { closeFullscreen } from "./fullscreen.js";
import { menu } from "./overlay.js";
import { installKeys } from "./keys.js";
import { handOver } from "./handover.js";
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

/** Plays tracks a Satellite's own page hands over (the UI contract's play action with
 * `tracks` or `route`, 1.2). Only from the Satellite the host plays from: the ids are resolved
 * through that provider, so a page can't make the player fetch anything its provider doesn't
 * offer. `options`: `start` (the id to begin with), `shuffle`, `queue` ("next" or "end": add
 * instead of replacing) and `context` (reported with each play). Resolves with how many tracks
 * it took. */
export async function playTracks(satellite, tracks, options = {}) {
    await start();
    const provider = library.currentProvider();
    if (!provider) {
        throw new Error("There is no audio library to play from.");
    }
    if (provider.satellite !== satellite) {
        throw new Error("The player plays from another audio library.");
    }
    return handOver(player(), tracks, options);
}

/** Tells `listener` the id of the track playing now whenever it changes, when it is one of
 * `satellite`'s (the audio.library provider's), else null - so a page marks its playing row
 * (the UI contract's `item.audio`, 1.2). Returns the function that stops it. */
export function nowPlaying(satellite, listener) {
    let off = null;
    let stopped = false;
    start().then((provider) => {
        if (stopped || !provider) {
            return;
        }
        const instance = player();
        let last;
        const tell = () => {
            const track = instance.current;
            const id = provider.satellite === satellite && track && track.id ? String(track.id) : null;
            if (id !== last) {
                last = id;
                listener(id);
            }
        };
        const offs = [instance.on("track", tell), instance.on("queue", tell)];
        off = () => offs.forEach((stop) => stop());
        tell();
    }).catch(() => {});
    return () => {
        stopped = true;
        if (off) {
            off();
        }
    };
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
            // what the provider's document adds to the player (its `audio`, UI contract 1.2)
            watchDocument(provider.satellite, { player, menu, handOver, playSearch, closeFullscreen });
            installKeys(toggleQueue);
            return provider;
        })();
    }
    return started;
}
