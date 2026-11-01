import * as api from "../api.js";
import { Effects, dbToGain } from "./effects.js";

const RETRIES = 4;
const PRELOAD_BEFORE = 25;

function deck() {
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "use-credentials";
    return audio;
}

// Two decks: the one playing and the one holding the next track, so a transition is either a
// crossfade or an immediate start of an already-buffered file.
export class Engine {
    constructor() {
        this.decks = [deck(), deck()];
        this.active = 0;
        this.effects = new Effects();
        this.handlers = new Map();
        this.track = null;
        this.plan = null;
        this.next = null;
        this.volume = 1;
        this.muted = false;
        this.speed = 1;
        this.preservePitch = true;
        this.crossfade = 0;
        this.gapless = true;
        this.quality = "original";
        this.format = "opus";
        this.replaygain = "album";
        this.needsGraph = false;
        this.buffering = false;
        this.error = null;
        this.retries = 0;
        this.fading = null;
        this.loadToken = 0;
        for (const audio of this.decks) {
            this.bind(audio);
        }
        window.addEventListener("online", () => {
            if (this.error && this.track) {
                this.retry(true);
            }
        });
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
            handler(detail);
        }
    }

    get audio() {
        return this.decks[this.active];
    }

    get standby() {
        return this.decks[1 - this.active];
    }

    get playing() {
        return Boolean(this.track) && !this.audio.paused;
    }

    get position() {
        return this.audio.currentTime || 0;
    }

    get duration() {
        const value = this.audio.duration;
        return Number.isFinite(value) ? value : (this.track && this.track.duration) || 0;
    }

    bind(audio) {
        const mine = () => audio === this.audio;
        audio.addEventListener("timeupdate", () => {
            if (mine()) {
                this.emit("time", { position: audio.currentTime, duration: this.duration });
                this.watchTransition();
            }
        });
        audio.addEventListener("waiting", () => mine() && this.setBuffering(true));
        audio.addEventListener("stalled", () => mine() && !audio.paused && this.setBuffering(true));
        audio.addEventListener("playing", () => {
            if (mine()) {
                this.setBuffering(false);
                this.retries = 0;
                this.error = null;
                this.emit("state");
            }
        });
        audio.addEventListener("canplay", () => mine() && this.setBuffering(false));
        audio.addEventListener("pause", () => mine() && this.emit("state"));
        audio.addEventListener("play", () => mine() && this.emit("state"));
        audio.addEventListener("loadedmetadata", () => mine() && this.emit("time", { position: audio.currentTime, duration: this.duration }));
        audio.addEventListener("ended", () => {
            if (!mine()) {
                return;
            }
            if (this.next && this.next.ready && this.gapless) {
                this.swap();
            } else {
                this.emit("ended");
            }
        });
        audio.addEventListener("error", () => {
            if (mine() && audio.getAttribute("src")) {
                this.failed(audio.error);
            } else if (!mine() && this.next) {
                this.next = null;
            }
        });
    }

    setBuffering(value) {
        if (this.buffering !== value) {
            this.buffering = value;
            this.emit("state");
        }
    }

    configure(preferences) {
        this.speed = Number(preferences.speed) || 1;
        this.preservePitch = preferences.preserve_pitch !== false;
        this.crossfade = Number(preferences.crossfade) || 0;
        this.gapless = preferences.gapless !== false;
        this.quality = preferences.streaming_quality || "original";
        this.format = preferences.transcode_format || "opus";
        this.replaygain = preferences.replaygain || "off";
        const equalizer = preferences.equalizer || {};
        this.needsGraph = Boolean(equalizer.enabled) || Number(preferences.bass_boost) > 0
            || this.replaygain !== "off" || Boolean(preferences.normalize) || (preferences.visualizer || "off") !== "off";
        if (this.needsGraph) {
            this.effects.ensure(this.decks);
        }
        this.effects.setEqualizer(equalizer);
        this.effects.setBass(preferences.bass_boost);
        this.effects.setNormalize(preferences.normalize);
        for (const audio of this.decks) {
            audio.playbackRate = this.speed;
            audio.preservesPitch = this.preservePitch;
            audio.webkitPreservesPitch = this.preservePitch;
        }
        this.applyVolume();
        this.emit("state");
    }

    applyVolume() {
        const level = this.muted ? 0 : this.volume;
        if (this.effects.active) {
            this.effects.setVolume(level);
        } else {
            for (const audio of this.decks) {
                const own = audio._level === undefined ? 1 : audio._level;
                const fade = audio._fade === undefined ? 1 : audio._fade;
                audio.volume = Math.max(0, Math.min(level * Math.min(own, 1) * fade, 1));
            }
        }
    }

    setVolume(value) {
        this.volume = Math.max(0, Math.min(Number(value), 1));
        this.muted = false;
        this.applyVolume();
        this.emit("state");
    }

    toggleMute() {
        this.muted = !this.muted;
        this.applyVolume();
        this.emit("state");
    }

    setLevel(audio, level, fade) {
        if (level !== undefined) {
            audio._level = level;
        }
        if (fade !== undefined) {
            audio._fade = fade;
        }
        if (!this.effects.setLevel(audio, audio._level === undefined ? 1 : audio._level, audio._fade === undefined ? 1 : audio._fade)) {
            this.applyVolume();
        }
    }

    async prepare(track, quality = this.quality) {
        const info = await api.get(`playback/${encodeURIComponent(track.id)}${api.query({ quality, format: this.format })}`);
        const gain = this.replaygain === "off" ? 0 : Math.max(-24, Math.min(Number(info.gain && info.gain.db) || 0, 12));
        return { track: info.track || track, plan: info.plan, src: api.url(info.stream), level: dbToGain(gain), gain: info.gain };
    }

    async load(track, { position = 0, autoplay = true } = {}) {
        const token = ++this.loadToken;
        this.cancelFade();
        this.next = null;
        this.standby.pause();
        this.standby.removeAttribute("src");
        this.track = track;
        this.plan = null;
        this.error = null;
        this.retries = 0;
        this.setBuffering(true);
        this.emit("track", track);
        let prepared;
        try {
            prepared = await this.prepare(track);
        } catch (error) {
            if (token === this.loadToken) {
                this.failed(error);
            }
            return false;
        }
        if (token !== this.loadToken) {
            return false;
        }
        this.track = { ...track, ...prepared.track };
        this.plan = prepared.plan;
        this.gain = prepared.gain;
        const audio = this.audio;
        audio.src = prepared.src;
        audio.playbackRate = this.speed;
        this.setLevel(audio, prepared.level, 1);
        if (position > 0) {
            audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.min(position, Math.max(this.duration - 1, 0)); }, { once: true });
        }
        this.emit("track", this.track);
        if (autoplay) {
            return this.play();
        }
        this.setBuffering(false);
        this.emit("state");
        return true;
    }

    async play() {
        if (!this.track) {
            return false;
        }
        if (this.needsGraph) {
            this.effects.ensure(this.decks);
        }
        const resumed = await this.effects.resume();
        try {
            await this.audio.play();
        } catch (error) {
            if (error && error.name === "NotAllowedError") {
                this.emit("blocked");
                return false;
            }
            if (error && error.name !== "AbortError") {
                this.failed(error);
            }
            return false;
        }
        if (!resumed) {
            this.emit("blocked");
        }
        return true;
    }

    pause() {
        this.audio.pause();
        if (this.fading) {
            this.standby.pause();
        }
    }

    toggle() {
        return this.audio.paused ? this.play() : this.pause();
    }

    seek(seconds) {
        if (!this.track) {
            return;
        }
        const target = Math.max(0, Math.min(Number(seconds) || 0, Math.max(this.duration - 0.25, 0)));
        this.audio.currentTime = target;
        this.emit("time", { position: target, duration: this.duration });
        this.emit("seek", target);
    }

    stop() {
        this.loadToken += 1;
        this.cancelFade();
        for (const audio of this.decks) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
        this.track = null;
        this.next = null;
        this.emit("track", null);
        this.emit("state");
    }

    async setNext(track) {
        if (!track) {
            this.next = null;
            return;
        }
        if (this.next && this.next.track.id === track.id) {
            return;
        }
        const entry = { track, ready: false };
        this.next = entry;
        try {
            const prepared = await this.prepare(track);
            if (this.next !== entry) {
                return;
            }
            Object.assign(entry, prepared);
            entry.ready = true;
        } catch (error) {
            if (this.next === entry) {
                this.next = null;
            }
        }
    }

    watchTransition() {
        const remaining = this.duration - this.position;
        if (!this.next || !this.track || this.audio.paused || !Number.isFinite(remaining)) {
            return;
        }
        if (this.next.ready && !this.next.loaded && remaining < Math.max(PRELOAD_BEFORE, this.crossfade + 5)) {
            const standby = this.standby;
            standby.src = this.next.src;
            standby.playbackRate = this.speed;
            standby.load();
            this.next.loaded = true;
        }
        if (this.crossfade > 0 && this.next.loaded && !this.fading && remaining <= this.crossfade && this.duration > this.crossfade * 2) {
            this.startCrossfade(remaining);
        }
    }

    startCrossfade(length) {
        const outgoing = this.audio;
        const incoming = this.standby;
        const next = this.next;
        this.setLevel(incoming, next.level, 0);
        incoming.play().catch(() => {});
        const started = performance.now();
        const total = Math.max(length, 0.5) * 1000;
        const step = () => {
            const progress = Math.min((performance.now() - started) / total, 1);
            this.setLevel(outgoing, undefined, Math.cos(progress * Math.PI / 2));
            this.setLevel(incoming, undefined, Math.sin(progress * Math.PI / 2));
            if (progress < 1 && this.fading) {
                this.fading.frame = requestAnimationFrame(step);
            } else if (this.fading) {
                this.fading = null;
                outgoing.pause();
                outgoing.removeAttribute("src");
            }
        };
        this.fading = { frame: requestAnimationFrame(step) };
        this.swap(true);
    }

    cancelFade() {
        if (this.fading) {
            cancelAnimationFrame(this.fading.frame);
            this.fading = null;
            this.setLevel(this.standby, undefined, 1);
            this.standby.pause();
        }
    }

    swap(fading = false) {
        const next = this.next;
        const previous = this.track;
        this.active = 1 - this.active;
        this.track = { ...next.track, ...(next.track || {}) };
        this.plan = next.plan;
        this.gain = next.gain;
        this.next = null;
        if (!fading) {
            this.setLevel(this.audio, next.level, 1);
            this.audio.play().catch((error) => this.failed(error));
        }
        this.emit("advance", { previous, track: this.track });
        this.emit("track", this.track);
    }

    failed(error) {
        const message = error && error.message ? error.message : "the track could not be played";
        if (error && error.status === 404) {
            this.error = message;
            this.setBuffering(false);
            this.emit("error", { message, fatal: true });
            return;
        }
        if (this.plan && this.plan.delivery === "transcode") {
            this.emit("notice", "Transcoded stream failed, playing the original file instead");
            this.retryWith("original");
            return;
        }
        if (this.retries < RETRIES) {
            this.retries += 1;
            this.error = `Connection problem, retrying (${this.retries}/${RETRIES})`;
            this.emit("state");
            setTimeout(() => this.retry(), 1000 * 2 ** (this.retries - 1));
            return;
        }
        this.error = message;
        this.setBuffering(false);
        this.emit("error", { message, fatal: false });
        this.emit("state");
    }

    async retryWith(quality) {
        const position = this.position;
        const token = ++this.loadToken;
        try {
            const prepared = await this.prepare(this.track, quality);
            if (token !== this.loadToken) {
                return;
            }
            this.plan = prepared.plan;
            this.audio.src = prepared.src;
            this.audio.addEventListener("loadedmetadata", () => { this.audio.currentTime = position; }, { once: true });
            this.emit("track", this.track);
            await this.audio.play();
        } catch (error) {
            this.error = error.message;
            this.emit("error", { message: error.message, fatal: false });
        }
    }

    retry(fromOnline = false) {
        if (!this.track) {
            return;
        }
        if (fromOnline) {
            this.retries = 0;
        }
        const position = this.position;
        const src = this.audio.getAttribute("src");
        const audio = this.audio;
        audio.src = src;
        audio.addEventListener("loadedmetadata", () => { audio.currentTime = position; }, { once: true });
        audio.play().catch(() => {});
    }
}
