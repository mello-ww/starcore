// "Sleep at end of this track" in the web AudioHost (mission_control/media/player.js): playback
// stops when the track ends, also when gapless playback or a crossfade would have moved
// straight into the next one. Run: node --test mission_control/tests/sleep.test.mjs
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// ---------- a browser, just enough of one ----------

class FakeAudio extends EventTarget {
    constructor() {
        super();
        this.attributes = new Map();
        this.paused = true;
        this.currentTime = 0;
        this.duration = 100;
        this.volume = 1;
        this.playbackRate = 1;
    }
    set src(value) { this.attributes.set("src", value); }
    get src() { return this.attributes.get("src") || ""; }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    load() {}
    async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
    end() { this.currentTime = this.duration; this.paused = true; this.dispatchEvent(new Event("ended")); }
}

const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.Audio = FakeAudio;
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "test" }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async (path) => {
    const id = decodeURIComponent(/\/play\/([^?]+)/.exec(path)?.[1] || "x");
    return { ok: true, status: 200, json: async () => ({ track: { id }, plan: null, stream: `audio/${id}`, gain: { db: 0 } }) };
};

const library = await import("../media/library.js");
library.setProvider({ satellite: "Tunes", operations: { search: "s", track: "t", resolve: "play", artwork: "a" }, session: {} });
const { player } = await import("../media/player.js");

const tracks = ["one", "two", "three"].map((id) => ({ id, title: id, duration: 100 }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(options = {}) {
    const instance = player();
    instance.cancelSleep();
    instance.shuffle = false;  // a test that shuffles must not reorder the next one's queue
    instance.repeat = options.repeat || "off";
    instance.engine.gapless = options.gapless !== false;
    instance.engine.crossfade = options.crossfade || 0;
    await instance.play(tracks, 0);
    await settle();
    return instance;
}

beforeEach(async () => {
    const instance = player();
    instance.cancelSleep();
    instance.engine.cancelFade();
    instance.engine.pause();
});

test("without sleep, the next track is lined up and gapless playback moves into it", async () => {
    const instance = await start();
    assert.equal(instance.engine.next?.track.id, "two");
    assert.equal(instance.engine.next.ready, true);
    instance.engine.audio.end();
    await settle();
    assert.equal(instance.current.id, "two");
    assert.equal(instance.engine.playing, true);
});

test("normal playback: stops at the end of the track it was set for", async () => {
    const instance = await start({ gapless: false });
    instance.setSleep("track");
    instance.engine.audio.end();
    await settle();
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.current.id, "one");
    assert.equal(instance.sleep, null);
});

test("gapless: nothing is lined up while sleep is set, so the track really ends and playback stops", async () => {
    const instance = await start();
    assert.equal(instance.engine.next?.track.id, "two");
    instance.setSleep("track");
    assert.equal(instance.engine.next, null);
    instance.engine.audio.end();
    await settle();
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.current.id, "one");
    assert.equal(instance.sleep, null);
});

test("cancelling the sleep lines the next track up again", async () => {
    const instance = await start();
    instance.setSleep("track");
    assert.equal(instance.engine.next, null);
    instance.cancelSleep();
    await settle();
    assert.equal(instance.engine.next?.track.id, "two");
});

test("crossfade: a fade is never started while sleep is set", async () => {
    const instance = await start({ crossfade: 6 });
    instance.setSleep("track");
    instance.engine.audio.currentTime = 97;
    instance.engine.watchTransition();
    assert.equal(instance.engine.fading, null);
    assert.equal(instance.current.id, "one");
});

test("crossfade already under way when sleep is set: playback stops at the change", async () => {
    const instance = await start({ crossfade: 6 });
    instance.engine.next.loaded = true;
    instance.engine.audio.currentTime = 97;
    // the fade has begun: the engine switches tracks as it starts
    instance.engine.fading = null;
    instance.sleep = { endOfTrack: true };
    instance.engine.startCrossfade(3);
    await settle();
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.engine.fading, null);
    assert.equal(instance.sleep, null);
});

test("repeat one: stops instead of starting the track again", async () => {
    const instance = await start({ repeat: "one" });
    instance.setSleep("track");
    instance.engine.audio.end();
    await settle();
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.current.id, "one");
    assert.equal(instance.engine.position, 100);
});

test("repeat all and shuffle with sleep set: still stops at the end of this track", async () => {
    const instance = await start({ repeat: "all" });
    instance.setShuffle(true);
    const id = instance.current.id;
    instance.setSleep("track");
    instance.engine.audio.end();
    await settle();
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.current.id, id);
});

test("the timed sleep is unchanged: it lines the next track up and stops after its time", async () => {
    const instance = await start();
    instance.setSleep(0.0005);
    assert.equal(instance.engine.next?.track.id, "two");
    // the 30 ms timer, then the 3.3 s fade-out
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.equal(instance.engine.playing, false);
    assert.equal(instance.sleep, null);
});
