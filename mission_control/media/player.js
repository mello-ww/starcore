import * as library from "./library.js";
import * as session from "./session.js";
import { Engine } from "./engine.js";

const SAVE_DELAY = 1500;
const DEVICE_KEY = "starcore.music.device";

function deviceId() {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
            const bytes = new Uint8Array(12);
            crypto.getRandomValues(bytes);
            id = `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch (error) {
        return `web-${Math.random().toString(36).slice(2, 14)}`;
    }
}

function shuffled(list) {
    const copy = list.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
}

function contextOf(context) {
    if (!context) {
        return null;
    }
    const [kind, ...rest] = String(context).split(":");
    const item = rest.join(":").replace(/[^\w:.-]+/g, "-").slice(0, 80);
    return `${kind}:${item}`;
}

class Player {
    constructor() {
        this.engine = new Engine();
        this.device = deviceId();
        this.queue = [];
        this.original = null;
        this.index = -1;
        this.shuffle = false;
        this.repeat = "off";
        this.context = null;
        this.handlers = new Map();
        this.listened = 0;
        this.lastTime = null;
        this.sleep = null;
        this.remote = null;
        this.blocked = false;
        this.restored = false;
        this.saveTimer = null;
        this.engine.on("time", (time) => this.onTime(time));
        this.engine.on("ended", () => this.onEnded());
        this.engine.on("advance", () => this.onAdvance());
        this.engine.on("state", () => { this.emit("state"); this.updateMediaSession(); });
        this.engine.on("track", () => { this.emit("track"); this.updateMediaSession(); });
        this.engine.on("seek", () => { this.lastTime = null; this.scheduleSave(); this.emit("seek"); });
        this.engine.on("blocked", () => { this.blocked = true; this.emit("blocked"); });
        this.engine.on("notice", (message) => session.toast(message));
        this.engine.on("error", (error) => {
            session.toast(error.message, "error");
            if (error.fatal) {
                this.next();
            }
        });
        session.on("preferences", (prefs) => this.engine.configure(prefs));
        this.setupMediaSession();
        window.addEventListener("pagehide", () => this.save(true));
    }

    on(name, handler) {
        if (!this.handlers.has(name)) {
            this.handlers.set(name, new Set());
        }
        this.handlers.get(name).add(handler);
        return () => this.handlers.get(name).delete(handler);
    }

    emit(name, detail) {
        for (const handler of this.handlers.get(name) || []) {
            try {
                handler(detail);
            } catch (error) {
                console.error(error);
            }
        }
    }

    get current() {
        return this.queue[this.index] || null;
    }

    get upcoming() {
        if (this.repeat === "one") {
            return null;
        }
        if (this.index + 1 < this.queue.length) {
            return this.queue[this.index + 1];
        }
        return this.repeat === "all" && this.queue.length > 1 ? this.queue[0] : null;
    }

    get playing() {
        return this.remote ? Boolean(this.remote.state && this.remote.state.playing) : this.engine.playing;
    }

    async restore() {
        if (this.restored) {
            return;
        }
        this.restored = true;
        await session.load().catch(() => {});
        if (session.state.preferences) {
            this.engine.configure(session.state.preferences);
        }
        try {
            const payload = await library.get("session", "queue", library.query({ device: this.device, expand: 1 }));
            const saved = payload.state;
            if (saved && saved.tracks && saved.tracks.length) {
                this.applyState(saved, saved.tracks, false);
            }
        } catch (error) {
            // nothing saved yet
        }
    }

    applyState(saved, tracks, autoplay) {
        const byId = new Map(tracks.map((track) => [track.id, track]));
        const queue = saved.queue.map((id) => byId.get(id)).filter(Boolean);
        if (!queue.length) {
            return;
        }
        this.queue = queue;
        this.shuffle = Boolean(saved.shuffle);
        this.repeat = saved.repeat || "off";
        this.context = saved.context || null;
        this.original = null;
        if (this.shuffle && Array.isArray(saved.order) && saved.order.length === queue.length) {
            const original = new Array(queue.length);
            saved.order.forEach((position, index) => { original[position] = queue[index]; });
            this.original = original.filter(Boolean);
        }
        this.index = Math.max(0, Math.min(saved.index || 0, queue.length - 1));
        if (saved.volume !== undefined && saved.volume !== null) {
            this.engine.setVolume(saved.volume);
        }
        this.emit("queue");
        this.listened = 0;
        return this.engine.load(this.current, { position: saved.position || 0, autoplay }).then(() => this.prefetch());
    }

    // ---------- starting playback ----------

    async play(tracks, start = 0, context = null) {
        const list = tracks.filter((track) => track && track.id && !track.missing);
        if (!list.length) {
            return;
        }
        if (this.remote) {
            return this.remoteCommand("set_queue", { tracks: list.map((track) => track.id), index: Math.min(start, list.length - 1), context });
        }
        this.report();
        this.context = contextOf(context);
        this.original = null;
        this.queue = list;
        this.index = Math.max(0, Math.min(start, list.length - 1));
        if (this.shuffle) {
            this.applyShuffle(true);
        }
        this.emit("queue");
        await this.load();
    }

    async load(position = 0) {
        this.listened = 0;
        this.lastTime = null;
        this.blocked = false;
        const ok = await this.engine.load(this.current, { position });
        this.prefetch();
        this.scheduleSave();
        this.emit("queue");
        return ok;
    }

    prefetch() {
        // with "end of this track" set, nothing is lined up: gapless playback and crossfade would
        // otherwise move straight into the next track, and the current one would never end
        this.engine.setNext(this.sleep && this.sleep.endOfTrack ? null : this.upcoming);
    }

    shufflePlay(tracks, context) {
        this.shuffle = true;
        const list = shuffled(tracks.filter((track) => !track.missing));
        return this.play(list, 0, context);
    }

    playNext(tracks) {
        const list = (Array.isArray(tracks) ? tracks : [tracks]).filter((track) => track && !track.missing);
        if (this.remote) {
            return this.remoteCommand("play_next", { tracks: list.map((track) => track.id) });
        }
        if (!this.current) {
            return this.play(list, 0, "queue:manual");
        }
        this.queue.splice(this.index + 1, 0, ...list);
        if (this.original) {
            this.original.push(...list);
        }
        this.changed();
        session.toast(list.length === 1 ? `"${list[0].title}" plays next` : `${list.length} tracks play next`);
    }

    addToQueue(tracks) {
        const list = (Array.isArray(tracks) ? tracks : [tracks]).filter((track) => track && !track.missing);
        if (this.remote) {
            return this.remoteCommand("add_queue", { tracks: list.map((track) => track.id) });
        }
        if (!this.current) {
            return this.play(list, 0, "queue:manual");
        }
        this.queue.push(...list);
        if (this.original) {
            this.original.push(...list);
        }
        this.changed();
        session.toast(list.length === 1 ? `Added "${list[0].title}" to the queue` : `Added ${list.length} tracks to the queue`);
    }

    remove(position) {
        if (position === this.index || position < 0 || position >= this.queue.length) {
            return;
        }
        const [removed] = this.queue.splice(position, 1);
        if (this.original) {
            const at = this.original.indexOf(removed);
            if (at >= 0) {
                this.original.splice(at, 1);
            }
        }
        if (position < this.index) {
            this.index -= 1;
        }
        this.changed();
    }

    move(from, to) {
        if (from === to || from < 0 || from >= this.queue.length) {
            return;
        }
        const current = this.current;
        const [item] = this.queue.splice(from, 1);
        this.queue.splice(Math.max(0, Math.min(to, this.queue.length)), 0, item);
        this.index = this.queue.indexOf(current);
        this.changed();
    }

    clear() {
        const current = this.current;
        this.queue = current ? [current] : [];
        this.original = null;
        this.index = current ? 0 : -1;
        this.changed();
    }

    jump(position) {
        if (position < 0 || position >= this.queue.length) {
            return;
        }
        this.report();
        this.index = position;
        this.load();
    }

    changed() {
        this.emit("queue");
        this.prefetch();
        this.scheduleSave();
    }

    // ---------- transport ----------

    toggle() {
        if (this.remote) {
            return this.remoteCommand("toggle");
        }
        if (!this.current) {
            return;
        }
        this.blocked = false;
        this.engine.toggle();
        this.scheduleSave();
    }

    resume() {
        if (this.remote) {
            return this.remoteCommand("play");
        }
        this.blocked = false;
        return this.engine.play();
    }

    pause() {
        if (this.remote) {
            return this.remoteCommand("pause");
        }
        this.engine.pause();
        this.scheduleSave();
    }

    async next(manual = true) {
        if (this.remote) {
            return this.remoteCommand("next");
        }
        if (!this.queue.length) {
            return;
        }
        this.report(manual);
        if (this.index + 1 < this.queue.length) {
            this.index += 1;
        } else if (this.repeat === "all" || this.repeat === "one") {
            this.index = 0;
        } else if (await this.autoplay()) {
            this.index += 1;
        } else {
            this.engine.pause();
            this.engine.seek(0);
            return;
        }
        await this.load();
    }

    previous() {
        if (this.remote) {
            return this.remoteCommand("previous");
        }
        if (this.engine.position > 3 || this.index === 0) {
            this.engine.seek(0);
            return;
        }
        this.report(true);
        this.index -= 1;
        this.load();
    }

    seek(seconds) {
        if (this.remote) {
            return this.remoteCommand("seek", { position: seconds });
        }
        this.engine.seek(seconds);
    }

    setVolume(value) {
        if (this.remote) {
            return this.remoteCommand("volume", { value });
        }
        this.engine.setVolume(value);
        this.scheduleSave();
    }

    setShuffle(on) {
        if (this.remote) {
            return this.remoteCommand("shuffle", { on });
        }
        this.shuffle = Boolean(on);
        this.applyShuffle(this.shuffle);
        this.changed();
    }

    applyShuffle(on) {
        const current = this.current;
        if (on) {
            if (!this.original) {
                this.original = this.queue.slice();
            }
            const rest = shuffled(this.queue.filter((_, position) => position !== this.index));
            this.queue = current ? [current, ...rest] : rest;
            this.index = current ? 0 : -1;
        } else if (this.original) {
            this.queue = this.original;
            this.original = null;
            this.index = Math.max(0, this.queue.indexOf(current));
        }
    }

    cycleRepeat() {
        const next = { off: "all", all: "one", one: "off" }[this.repeat];
        if (this.remote) {
            return this.remoteCommand("repeat", { mode: next });
        }
        this.repeat = next;
        this.changed();
    }

    async autoplay() {
        if (session.preference("queue_end", "stop") !== "autoplay" || !this.current) {
            return false;
        }
        try {
            const station = await library.get("session", "radio", `/track/${encodeURIComponent(this.current.id)}`);
            const known = new Set(this.queue.map((track) => track.id));
            const fresh = station.tracks.filter((track) => !known.has(track.id)).slice(0, 25);
            if (!fresh.length) {
                return false;
            }
            this.queue.push(...fresh);
            if (this.original) {
                this.original.push(...fresh);
            }
            this.emit("queue");
            session.toast("Autoplay: continuing with similar tracks from your library");
            return true;
        } catch (error) {
            return false;
        }
    }

    onEnded() {
        if (this.sleep && this.sleep.endOfTrack) {
            this.report(false);
            this.cancelSleep();
            this.engine.pause();
            session.toast("Sleep timer: playback stopped");
            return;
        }
        if (this.repeat === "one") {
            this.report(false);
            this.listened = 0;
            this.engine.seek(0);
            this.engine.play();
            return;
        }
        this.next(false);
    }

    onAdvance() {
        // a transition already under way when "end of this track" was set (a crossfade that had
        // begun): the track it was set for is over, so stop here
        if (this.sleep && this.sleep.endOfTrack) {
            this.engine.cancelFade();
            this.engine.pause();
            this.report(false);
            this.listened = 0;
            this.lastTime = null;
            this.index = this.index + 1 < this.queue.length ? this.index + 1 : 0;
            this.cancelSleep();
            this.emit("queue");
            this.scheduleSave();
            session.toast("Sleep timer: playback stopped");
            return;
        }
        this.report(false);
        this.listened = 0;
        this.lastTime = null;
        this.index = this.index + 1 < this.queue.length ? this.index + 1 : 0;
        this.emit("queue");
        this.prefetch();
        this.scheduleSave();
    }

    onTime({ position }) {
        if (this.lastTime !== null) {
            const delta = position - this.lastTime;
            if (delta > 0 && delta < 3) {
                this.listened += delta;
            }
        }
        this.lastTime = position;
        this.emit("time");
        if (this.engine.playing && Math.floor(position) % 15 === 0) {
            this.scheduleSave();
        }
        this.updatePosition();
    }

    report(manual = false) {
        const track = this.current;
        if (!track || this.listened < 1) {
            this.listened = 0;
            return;
        }
        const seconds = Math.round(this.listened);
        this.listened = 0;
        library.post("session", "history", "", { track_id: track.id, seconds, device: this.device, context: this.context || (manual ? "queue:manual" : null) }, { keepalive: true })
            .catch(() => {});
    }

    // ---------- sleep timer ----------

    setSleep(minutes) {
        this.cancelSleep();
        if (minutes === "track") {
            this.sleep = { endOfTrack: true };
            this.prefetch();
        } else if (minutes > 0) {
            const until = Date.now() + minutes * 60000;
            this.sleep = { until, timer: setTimeout(() => this.fadeToSleep(), minutes * 60000) };
        }
        this.emit("sleep");
    }

    async fadeToSleep() {
        const start = this.engine.volume;
        for (let step = 10; step >= 0; step -= 1) {
            this.engine.effects.active ? this.engine.effects.setVolume(start * step / 10) : (this.engine.audio.volume = start * step / 10);
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        this.engine.pause();
        this.engine.setVolume(start);
        this.sleep = null;
        this.emit("sleep");
        session.toast("Sleep timer: playback stopped");
    }

    cancelSleep() {
        const endOfTrack = Boolean(this.sleep && this.sleep.endOfTrack);
        if (this.sleep && this.sleep.timer) {
            clearTimeout(this.sleep.timer);
        }
        this.sleep = null;
        if (endOfTrack) {
            this.prefetch();
        }
        this.emit("sleep");
    }

    // ---------- persistence ----------

    snapshot() {
        const order = this.original ? this.queue.map((track) => this.original.indexOf(track)) : null;
        return {
            queue: this.queue.map((track) => track.id),
            index: Math.max(this.index, 0),
            order: order && order.every((value) => value >= 0) ? order : null,
            position: this.engine.position,
            duration: this.engine.duration,
            playing: this.engine.playing,
            shuffle: this.shuffle,
            repeat: this.repeat,
            volume: this.engine.volume,
            speed: this.engine.speed,
            context: this.context,
        };
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY);
    }

    save(final = false) {
        clearTimeout(this.saveTimer);
        if (!this.queue.length) {
            return Promise.resolve();
        }
        const state = this.snapshot();
        if (final) {
            state.playing = false;
        }
        this.emit("saved", state);
        return library.post("session", "queue", "", { device: this.device, name: deviceName(), kind: "web", state }, { keepalive: final }).catch(() => {});
    }

    // ---------- remote control (StarCore Connect) ----------

    setRemote(remote) {
        this.remote = remote;
        this.emit("state");
        this.emit("remote");
    }

    remoteCommand(command, args = {}) {
        if (!this.remote) {
            return null;
        }
        return library.post("session", "connect", "/command", { device_id: this.device, target: this.remote.device.id, command, arguments: args })
            .catch((error) => session.toast(error.message, "error"));
    }

    // ---------- Media Session ----------

    setupMediaSession() {
        if (!("mediaSession" in navigator)) {
            return;
        }
        const handlers = {
            play: () => this.resume(),
            pause: () => this.pause(),
            nexttrack: () => this.next(),
            previoustrack: () => this.previous(),
            seekto: (details) => this.seek(details.seekTime),
            seekbackward: (details) => this.seek(this.engine.position - (details.seekOffset || 10)),
            seekforward: (details) => this.seek(this.engine.position + (details.seekOffset || 10)),
            stop: () => this.pause(),
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (error) {
                // an action this browser doesn't support
            }
        }
    }

    updateMediaSession() {
        if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") {
            return;
        }
        const track = this.engine.track;
        if (!track) {
            navigator.mediaSession.metadata = null;
            return;
        }
        if (this.metadataFor !== track.id) {
            this.metadataFor = track.id;
            const artwork = track.album_id ? [96, 300, 600].map((size) => ({ src: library.artworkUrl(track.album_id, size), sizes: `${size}x${size}` })) : [];
            navigator.mediaSession.metadata = new MediaMetadata({ title: track.title || "", artist: track.artist || track.album_artist || "", album: track.album || "", artwork });
        }
        navigator.mediaSession.playbackState = this.engine.playing ? "playing" : "paused";
        this.updatePosition();
    }

    updatePosition() {
        if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) {
            return;
        }
        const duration = this.engine.duration;
        if (!duration || !Number.isFinite(duration)) {
            return;
        }
        try {
            navigator.mediaSession.setPositionState({ duration, playbackRate: this.engine.speed || 1, position: Math.min(this.engine.position, duration) });
        } catch (error) {
            // position briefly ahead of a changing duration
        }
    }
}

export function deviceName() {
    const agent = navigator.userAgent;
    const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
    return `Mission Control (${browser})`;
}

let instance = null;

export function player() {
    if (!instance) {
        instance = new Player();
    }
    return instance;
}
