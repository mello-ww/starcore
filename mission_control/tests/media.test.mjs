// The web audio host's provider handling (mission_control/media/, docs/media-audio.md).
// Run: node --test mission_control/tests/media.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const requests = [];
globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET" });
    const tune = /^\/api\/satellites\/Radio\/tune\/([^?]+)/.exec(path);
    const body = tune ? { track: {}, plan: null, stream: `listen/${tune[1]}`, gain: { db: 0 } } : { state: null };
    return { ok: true, status: 200, json: async () => body };
};

const library = await import("../media/library.js");
const session = await import("../media/session.js");

// a provider this client has never heard of: its name and routes are only in this test
const radio = { satellite: "Radio", version: 1, enabled: true, operations: { search: "find", track: "item", resolve: "tune", artwork: "cover" } };

test("the first enabled audio.library v1 provider, with that Satellite's own session", () => {
    const capabilities = {
        "audio.library": [{ ...radio, satellite: "Off", enabled: false }, { ...radio, version: 2 }, radio, { ...radio, satellite: "Later" }],
        "audio.session": [
            { satellite: "Later", version: 1, enabled: true, operations: { queue: "queue" } },
            { satellite: "Radio", version: 2, enabled: true, operations: { queue: "v2" } },
        ],
    };
    assert.deepEqual(library.resolveProvider(capabilities), { satellite: "Radio", operations: radio.operations, session: {} });
    capabilities["audio.session"].push({ satellite: "Radio", version: 1, enabled: true, operations: { queue: "saved" } });
    assert.deepEqual(library.resolveProvider(capabilities).session, { queue: "saved" });
    assert.equal(library.resolveProvider({}), null);
    assert.equal(library.resolveProvider(null), null);
});

test("plays from the provider's own routes, found only through the catalog", async () => {
    library.setProvider(library.resolveProvider({ "audio.library": [radio] }));
    await library.ready;
    const info = await library.get("operations", "resolve", "/t1");
    assert.equal(requests.at(-1).path, "/api/satellites/Radio/tune/t1");
    assert.equal(library.url(info.stream), "/api/satellites/Radio/listen/t1");
    assert.equal(library.artworkUrl("a1", 96), "/api/satellites/Radio/cover/a1?size=96");
    assert.equal(library.offers("lyrics"), false);
});

test("an operation the provider lacks is a rejected promise and sends nothing", async () => {
    const before = requests.length;
    let pending = null;
    assert.doesNotThrow(() => { pending = library.post("session", "history", "", { track_id: "t1" }); });
    await assert.rejects(pending, /doesn't offer history/);
    await assert.rejects(library.get("operations", "lyrics", "/t1"), /doesn't offer lyrics/);
    await session.load();
    await session.setLiked("track", "t1", true);
    assert.equal(await session.setPreferences({ speed: 2 }), null);
    assert.equal(session.isLiked("track", "t1"), false);
    assert.equal(session.offersLikes(), false);
    assert.equal(requests.length, before);
});

test("a page's tracks replace the queue from the one asked for, shuffle, or join the queue", async () => {
    const { handOver, playable } = await import("../media/handover.js");
    const calls = [];
    const fake = {
        play: async (list, start, context) => calls.push(["play", list.map((track) => track.id), start, context]),
        shufflePlay: async (list, context) => calls.push(["shuffle", list.length, context]),
        playNext: async (list) => calls.push(["next", list.map((track) => track.id)]),
        addToQueue: async (list) => calls.push(["end", list.map((track) => track.id)]),
    };
    const tracks = [{ id: "a" }, { id: "b", missing: true }, { title: "no id" }, null, "c", { id: "d" }];
    assert.deepEqual(playable(tracks).map((track) => track.id), ["a", "d"]);
    assert.deepEqual(playable({ id: "a" }), []);
    assert.equal(await handOver(fake, tracks, { start: "d", context: "album:1" }), 2);
    assert.equal(await handOver(fake, tracks, { start: "gone" }), 2);
    assert.equal(await handOver(fake, tracks, { shuffle: true, context: "x".repeat(90) }), 2);
    assert.equal(await handOver(fake, [{ id: "a" }], { queue: "next" }), 1);
    assert.equal(await handOver(fake, [{ id: "a" }], { queue: "end" }), 1);
    assert.equal(await handOver(fake, [], {}), 0);
    assert.equal(await handOver(fake, null, {}), 0);
    assert.deepEqual(calls, [
        ["play", ["a", "d"], 1, "album:1"],
        ["play", ["a", "d"], 0, null],
        ["shuffle", 2, "x".repeat(80)],
        ["next", ["a"]],
        ["end", ["a"]],
    ]);
});

test("a shuffle over a long list draws every position once, a few at a time", async () => {
    const { lazyPositions } = await import("../media/handover.js");
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const positions = lazyPositions(10000, random);
    const drawn = [...positions.draw(100), ...positions.draw(50)];
    assert.equal(drawn.length, 150);
    assert.equal(positions.left, 9850);
    while (positions.left) {
        drawn.push(...positions.draw(1000));
    }
    assert.equal(new Set(drawn).size, 10000);
    assert.ok(drawn.every((position) => position >= 0 && position < 10000));
    assert.notDeepEqual(drawn.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(lazyPositions(0).draw(5), []);
});

/** A player as the handover sees it: a queue, a context, events. */
function fakePlayer() {
    const handlers = new Map();
    const player = {
        queue: [], index: 0, context: null, remote: null, added: [],
        on(name, handler) {
            handlers.set(name, [...(handlers.get(name) || []), handler]);
            return () => handlers.set(name, handlers.get(name).filter((other) => other !== handler));
        },
        emit(name) { (handlers.get(name) || []).forEach((handler) => handler()); },
        async play(list, start, context) { this.queue = list.slice(); this.index = start; this.context = context; },
        async shufflePlay(list, context) { return this.play(list, 0, context); },
        async addToQueue(list, options) { this.added.push([list.length, options]); this.queue.push(...list); this.emit("queue"); },
        listeners: () => [...handlers.values()].flat().length,
    };
    return player;
}

const pageOf = (from, size, count) => Array.from({ length: Math.max(0, Math.min(size, count - from)) }, (_, at) => ({ id: `t${from + at}` }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a paged route's list is queued page by page as it plays, then stops when replaced", async () => {
    const { handOver } = await import("../media/handover.js");
    const asked = [];
    const load = async (params) => {
        asked.push(params);
        const from = Number(params.cursor);
        return { tracks: pageOf(from, 50, 120), count: 120, cursor: from + 50 < 120 ? String(from + 50) : null };
    };
    const player = fakePlayer();
    const answer = { tracks: pageOf(0, 50, 120), count: 120, cursor: "50" };
    assert.equal(await handOver(player, answer.tracks, { context: "liked", page: { answer, load } }), 50);
    await settle();
    assert.equal(player.queue.length, 50);  // 49 left: nothing asked yet
    assert.deepEqual(asked, []);
    player.index = 30;  // 19 left
    player.emit("track");
    await settle();
    assert.deepEqual(asked, [{ cursor: "50" }]);
    assert.equal(player.queue.length, 100);
    assert.deepEqual(player.added, [[50, { quiet: true }]]);
    assert.equal(player.queue[99].id, "t99");
    // another list replaces the queue: nothing more is asked for, and the listeners are gone
    await player.play([{ id: "x" }], 0, "album:1");
    player.emit("track");
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(player.listeners(), 0);
});

test("shuffling a paged list asks only for the positions it draws, and its first page is never asked again", async () => {
    const { handOver } = await import("../media/handover.js");
    const asked = [];
    const load = async (params) => {
        asked.push(params);
        const positions = params.positions.split(",").map(Number);
        assert.ok(positions.length <= 50);
        return { tracks: positions.map((position) => ({ id: `t${position}` })), count: 10000 };
    };
    const player = fakePlayer();
    const answer = { tracks: pageOf(0, 100, 10000), count: 10000, cursor: "100" };
    assert.equal(await handOver(player, answer.tracks, { shuffle: true, context: "liked", page: { answer, load } }), 100);
    assert.equal(player.queue.length, 100);
    assert.ok(asked.length >= 2 && asked.length <= 3);
    const fromFirstPage = asked.flatMap((params) => params.positions.split(",").map(Number)).filter((position) => position < 100);
    assert.deepEqual(fromFirstPage, []);
    assert.equal(new Set(player.queue.map((track) => track.id)).size, 100);
    player.index = 80;
    player.emit("track");
    await settle();
    assert.equal(player.queue.length, 150);
    assert.equal(new Set(player.queue.map((track) => track.id)).size, 150);
});
