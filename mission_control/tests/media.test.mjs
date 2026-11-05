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
