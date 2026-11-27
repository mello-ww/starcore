// The web audio host's provider handling (mission_control/media/, docs/reference/media-audio.md).
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

// UI contract 1.2, the document's `audio`: what the player adds while it plays from a provider
const AUDIO = {
    menu: [
        { label: "Start radio", icon: "activity", action: { play: { route: "radio/track/{$.id}" } } },
        { label: "Go to album", visible: "$.album_id", action: { navigate: "album", params: { id: "$.album_id" } } },
        { label: "Keep", action: { route: "tracks/{$.id}/keep", reloads: "audio.session" } },
    ],
    album: { navigate: "album", params: { id: "$.album_id" } },
    artist: { navigate: "artist", params: { id: "$.artist_id" } },
    library: { label: "Open Radio", action: { navigate: "home" } },
};

function fakeDeps() {
    const calls = { open: [], post: [], load: [], play: [], reload: [], notify: [] };
    return {
        calls,
        open: (section) => calls.open.push(section),
        load: async (route) => {
            calls.load.push(route);
            return { tracks: [{ id: "r1" }, { id: "r2" }], context: "radio:track-t1" };
        },
        post: async (route, body) => {
            calls.post.push([route, body]);
            return { message: "Kept." };
        },
        play: async (tracks, options) => {
            calls.play.push([tracks, options.context]);
            return tracks.length;
        },
        playSearch: async () => 0,
        choose: async () => null,
        confirm: () => true,
        reload: async (capability) => calls.reload.push(capability),
        notify: (message, kind) => calls.notify.push([message, kind]),
    };
}

test("the player's menu and links come from the provider's document, with the playing track as $.", async () => {
    const { actionRunner, audioHooks } = await import("../media/document.js");
    const deps = fakeDeps();
    const run = actionRunner(deps);
    const menus = [];
    const track = { id: "t1", album_id: "a1", artist_id: "p1" };
    const hooks = audioHooks(AUDIO, { run, menu: (items) => menus.push(items), current: () => track, playNext: () => {} });
    assert.deepEqual(hooks.menuEntries(track).map((entry) => entry.label), ["Start radio", "Go to album", "Keep"]);
    assert.deepEqual(hooks.menuEntries({ id: "t2" }).map((entry) => entry.label), ["Start radio", "Keep"]);
    await hooks.openAlbum("a1", track);
    await hooks.openArtist("p2", track);  // one of several artists: its own id
    await hooks.openLibrary.action();
    assert.deepEqual(deps.calls.open, ["album?id=a1", "artist?id=p2", "home"]);
    await hooks.menuEntries(track)[0].action();
    assert.deepEqual(deps.calls.load, ["radio/track/t1"]);
    assert.deepEqual(deps.calls.play, [[[{ id: "r1" }, { id: "r2" }], "radio:track-t1"]]);
    hooks.trackMenu(track, null, [{ label: "Remove from queue", action: () => {} }]);
    assert.deepEqual(menus[0].map((item) => (item === "-" ? "-" : item.label)),
        ["Play next", "-", "Start radio", "Go to album", "Keep", "-", "Remove from queue"]);
});

test("without audio the host adds nothing, and a route outside the Satellite is refused", async () => {
    const { actionRunner, audioHooks } = await import("../media/document.js");
    assert.deepEqual(audioHooks(undefined, {}), {});
    const deps = fakeDeps();
    const run = actionRunner(deps);
    assert.equal(await run({ route: "../api/auth" }, { id: "t1" }), false);
    assert.deepEqual(deps.calls.post, []);
    assert.equal(deps.calls.notify[0][1], "error");
});

test("a route action with reloads reloads the host's preferences and likes once it succeeded", async () => {
    const { actionRunner } = await import("../media/document.js");
    const deps = fakeDeps();
    const run = actionRunner(deps);
    assert.equal(await run(AUDIO.menu[2].action, { id: "t1" }), true);
    assert.deepEqual(deps.calls.post, [["tracks/t1/keep", {}]]);
    assert.deepEqual(deps.calls.reload, ["audio.session"]);
    assert.deepEqual(deps.calls.notify, [["Kept.", "info"]]);
    deps.post = async () => { throw new Error("No."); };
    assert.equal(await actionRunner(deps)(AUDIO.menu[2].action, { id: "t1" }), false);
    assert.deepEqual(deps.calls.reload, ["audio.session"]);  // a failed one reloads nothing
});

test("a locate entry shows the track's folder from the path its route answers (change 18)", async () => {
    const { actionRunner } = await import("../media/document.js");
    const located = [];
    const deps = { ...fakeDeps(), load: async (route) => (route === "tracks/t1?page=1" ? { location: "/music/a.flac" } : {}),
        locate: async (path) => located.push(path) > 0 };
    const action = { locate: "$.location", route: "tracks/{$.id}?page=1" };
    assert.equal(await actionRunner(deps)(action, { id: "t1" }), true);
    assert.deepEqual(located, ["/music/a.flac"]);
    // a file the session can't browse answers no path; an outside route is refused
    assert.equal(await actionRunner(deps)(action, { id: "t2" }), false);
    assert.equal(await actionRunner(deps)({ locate: "$.location", route: "../api/x" }, { id: "t1" }), false);
    assert.deepEqual(located, ["/music/a.flac"]);
    assert.deepEqual(deps.calls.notify.map((entry) => entry[1]), ["error", "error"]);
});

test("session.reload reads preferences and likes again; only a change the client makes itself is followed", async () => {
    library.setProvider(library.resolveProvider({
        "audio.library": [radio],
        "audio.session": [{ satellite: "Radio", version: 1, enabled: true, operations: { preferences: "prefs", favorites: "likes" } }],
    }));
    const saved = globalThis.fetch;
    let liked = ["t9"];
    globalThis.fetch = async (path, options = {}) => {
        const body = path.endsWith("/prefs") ? { speed: 1.5 } : { ids: { track: liked } };
        if (options.method === "POST" && path.endsWith("/likes")) {
            liked = [...liked, ...JSON.parse(options.body).ids];
        }
        return { ok: true, status: 200, json: async () => ({ ...body, ids: { track: liked } }) };
    };
    const changed = [];
    const off = session.on("changed", (capability) => changed.push(capability));
    try {
        await session.reload();
        assert.equal(session.preference("speed", 1), 1.5);
        assert.equal(session.isLiked("track", "t9"), true);
        assert.deepEqual(changed, []);
        await session.setLiked("track", "t3", true);
        assert.equal(session.isLiked("track", "t3"), true);
        assert.deepEqual(changed, ["audio.session"]);
    } finally {
        off();
        globalThis.fetch = saved;
    }
});

test("repeat cycles off, all and one, and on a radio between off and one only", async () => {
    const { nextRepeat } = await import("../media/repeat.js");
    assert.deepEqual(["off", "all", "one"].map((mode) => nextRepeat(mode, "album:a1")), ["all", "one", "off"]);
    assert.deepEqual(["off", "all", "one"].map((mode) => nextRepeat(mode, "radio:track-t1")), ["one", "off", "off"]);
    assert.equal(nextRepeat("off", null), "all");
});

test("the keyboard shortcuts: wherever something is loaded, never while typing or over a dialog", async () => {
    const { shortcut } = await import("../media/keyrule.js");
    const base = { typing: false, blocked: false, hasTrack: true, onBody: true, onButton: false, fullscreen: false };
    const press = (key, extra = {}, state = {}) => shortcut({ key, ...extra }, { ...base, ...state });
    assert.equal(press(" "), "toggle");
    assert.equal(press(" ", {}, { onButton: true }), null);
    assert.equal(press("ArrowRight", { shiftKey: true }), "next");
    assert.equal(press("ArrowLeft"), "back");
    assert.equal(press("ArrowRight", {}, { onBody: false }), null);
    assert.equal(press("m"), "mute");
    assert.equal(press("/"), "search");
    // typing, a menu or dialog (the media viewer too), a modifier: left to the page
    assert.equal(press(" ", {}, { typing: true }), null);
    assert.equal(press(" ", {}, { blocked: true }), null);
    assert.equal(press("m", { ctrlKey: true }), null);
    // nothing loaded: only the full player keeps its keys
    assert.equal(press(" ", {}, { hasTrack: false }), null);
    assert.equal(press("q", {}, { hasTrack: false }), null);
    assert.equal(press("q", {}, { hasTrack: false, fullscreen: true }), "queue");
    assert.equal(press("l", {}, { hasTrack: false, fullscreen: true }), null);
});
