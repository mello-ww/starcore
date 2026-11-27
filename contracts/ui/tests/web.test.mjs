// Mission Control's contract module against the shared fixtures.
// Run from the repository root: node --test contracts/ui/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as contract from "../../../mission_control/ui/contract.js";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const load = (name) => JSON.parse(readFileSync(here(`../fixtures/${name}`), "utf-8"));
const vocabulary = JSON.parse(readFileSync(here("../vocabulary.json"), "utf-8"));

test("the vocabulary is the shared one", () => {
    assert.equal(`${contract.MAJOR}.${contract.MINOR}`, vocabulary.version);
    assert.deepEqual([...contract.BLOCK_TYPES].sort(), Object.keys(vocabulary.blocks).sort());
    assert.deepEqual([...contract.FORMATS].sort(), [...vocabulary.formats].sort());
    assert.deepEqual([...contract.TONES].sort(), [...vocabulary.tones].sort());
    assert.deepEqual([...contract.ICONS].sort(), [...vocabulary.icons].sort());
    assert.deepEqual([...contract.FORM_FIELD_KINDS].sort(), [...vocabulary.form_field_kinds].sort());
    assert.deepEqual([...contract.SECRET_KINDS].sort(), [...vocabulary.secret_kinds].sort());
    for (const name of Object.keys(contract.CAPABILITY_VERSIONS)) {
        assert.ok(vocabulary.satellite_capabilities[name], name);
    }
    const isProtected = Object.fromEntries(Object.entries(vocabulary.protected_capabilities).filter(([name]) => !name.startsWith("_")));
    assert.deepEqual(contract.PROTECTED_CAPABILITIES, isProtected);
    const sync = Object.fromEntries(Object.entries(vocabulary.sync_capabilities).filter(([name]) => !name.startsWith("_")));
    assert.deepEqual(contract.SYNC_CAPABILITIES, sync);
    for (const client of Object.values(sync)) {
        assert.ok(vocabulary.client_capabilities.reserved.includes(client), client);
    }
    const kinds = Object.fromEntries(Object.entries(vocabulary.file_kinds).filter(([name]) => !name.startsWith("_")));
    assert.deepEqual(contract.FILE_KINDS, kinds);
});

test("openers (change 16): the enabled files.open providers whose extensions hold the file's", () => {
    const opener = (satellite, extra) => ({ satellite, version: 1, enabled: true, operations: { open: "open" }, ...extra });
    const providers = {
        "files.open": [
            opener("Pictures", { types: ["image", "video"], label: "Pictures" }),
            opener("Player", { types: ["audio"] }),
            opener("Raw", { types: ["image"], extensions: [".cr2"] }),
            opener("Off", { types: ["image"], enabled: false }),
            opener("Future", { types: ["image"], version: 2 }),
            opener("Broken", { types: ["image"], operations: {} }),
        ],
    };
    const names = (path) => contract.openersFor(providers, path).map((entry) => entry.satellite);
    assert.deepEqual(names("/data/Holiday/Beach.JPG"), ["Pictures"]);
    assert.deepEqual(names("C:\Music\song.flac"), ["Player"]);
    assert.deepEqual(names("/data/raw/IMG_1.cr2"), ["Raw"]);
    assert.deepEqual(names("/data/notes.txt"), []);
    assert.deepEqual(names("/data/.jpg"), []);
    assert.deepEqual(names("/data/no-extension"), []);
    assert.deepEqual(contract.openersFor({}, "/a.jpg"), []);
    assert.equal(contract.fileExtension("/a/b.tar.GZ"), ".gz");
});

test("an opener's or locate's answer opens only a page of the provider, with string params", () => {
    assert.equal(contract.openedSection({ page: "folder", params: { path: "/data/a b", select: "x.jpg" } }),
        "folder?path=%2Fdata%2Fa+b&select=x.jpg");
    assert.equal(contract.openedSection({ page: "viewer" }), "viewer");
    for (const answer of [null, {}, { page: "../x" }, { page: "Folder" }, { page: "folder", params: { path: 3 } },
        { page: "folder", params: ["x"] }, { page: "#/satellite/Other" }]) {
        assert.equal(contract.openedSection(answer), null, JSON.stringify(answer));
    }
    const browse = (operations) => ({ "files.browse": [{ satellite: "Files", version: 1, enabled: true, operations }] });
    assert.equal(contract.locateProvider(browse({ list: "entries", locate: "locate" })).satellite, "Files");
    assert.equal(contract.locateProvider(browse({ list: "entries" })), null);
    assert.equal(contract.locateProvider(null), null);
});

test("a sync action opens only a sync screen this client has", () => {
    // Mission Control can't back a device up in the background: it has no such screen
    assert.equal(contract.canOpenSync({ sync: { capability: "media.sync" } }), false);
    assert.equal(contract.canOpenSync({ sync: { capability: "toString" } }), false);
    assert.equal(contract.canOpenSync({ sync: "media.sync" }), false);
    assert.equal(contract.canOpenSync({ navigate: "home" }), false);
    contract.CLIENT_CAPABILITIES.add("device.media-sync");
    try {
        assert.equal(contract.canOpenSync({ sync: { capability: "media.sync" } }), true);
        assert.equal(contract.canOpenSync({ sync: { capability: "media.gallery" } }), false);
    } finally {
        contract.CLIENT_CAPABILITIES.delete("device.media-sync");
    }
});

test("bindings", () => {
    const { context, resolve } = load("bindings.json");
    for (const { expr, expected } of resolve) {
        assert.deepEqual(contract.resolve(expr, context), expected, JSON.stringify(expr));
    }
});

test("route templates", () => {
    const { context, templates } = load("bindings.json");
    for (const { template, expected } of templates) {
        assert.equal(contract.resolveTemplate(template, context), expected, template);
    }
});

test("route safety", () => {
    const { safe, unsafe } = load("routes.json");
    for (const route of safe) {
        assert.equal(contract.isSafeRoute(route), true, route);
    }
    for (const route of unsafe) {
        assert.equal(contract.isSafeRoute(route), false, route);
    }
});

test("formats and visibility", () => {
    const { cases, visible } = load("formats.json");
    for (const { value, format, unit, options, expected } of cases) {
        assert.equal(contract.formatValue(value, format, unit, options), expected, `${JSON.stringify(value)} ${format}`);
    }
    for (const { value, expected } of visible) {
        assert.equal(contract.isVisible(value), expected, JSON.stringify(value));
    }
});

test("documents: valid ones render, ones every client must refuse are refused", () => {
    const { valid, invalid } = load("documents.json");
    for (const { name, document } of valid) {
        assert.equal(contract.checkDocument(document), null, name);
    }
    for (const { name, document, client } of invalid) {
        if (client) {
            assert.notEqual(contract.checkDocument(document), null, name);
        }
    }
});

test("a Satellite's own icons: the shared vocabulary's limits, and only absolute M, L, C and Z", () => {
    assert.equal(vocabulary.limits.icons, 64);
    assert.equal(vocabulary.limits.icon_paths, 32);
    assert.ok(contract.ICON_PATH.test("M2 12L22 12C22 17.523 17.523 22 12 22Z"));
    assert.ok(contract.ICON_PATH.test("M-1.5 0L1 1ZM3 3L4 4"));
    for (const path of ["", "L1 1", "M1 1l2 2", "M1 1 L2 2", "M1 1H2", "M1e3 1", "M1 1Q1 1 2 2", "M1 1C1 1 2 2"]) {
        assert.ok(!contract.ICON_PATH.test(path), path);
    }
    assert.ok(contract.knownIcons({ albums: { fallback: "folder" } }));
    assert.ok(!contract.knownIcons({ albums: { fallback: "folder", paths: ["M1 1L2 2"] } }));  // no stroke
    assert.ok(!contract.knownIcons({ albums: { fallback: "folder", stroke: 2, paths: [] } }));
    assert.ok(!contract.knownIcons({ "Albums": { fallback: "folder" } }));
    assert.ok(!contract.knownIcons([]));
});

test("requirements and capability providers", () => {
    const providers = {
        "files.browse": [
            { satellite: "Off", version: 1, enabled: false, operations: { list: "entries" } },
            { satellite: "On", version: 1, enabled: true, operations: { list: "entries" } },
        ],
        "future.thing": [{ satellite: "X", version: 1, enabled: true, operations: {} }],
    };
    assert.equal(contract.findProvider(providers, "files.browse").satellite, "On");
    assert.equal(contract.findProvider({ "files.browse": [{ version: 2, enabled: true }] }, "files.browse"), null);
    assert.deepEqual(contract.missingRequirements({ capabilities: ["files.browse"] }, providers), []);
    // the play action (1.2): this client offers media.audio, and plays from any audio.library provider
    const audio = { "audio.library": [{ satellite: "Anything", version: 1, enabled: true, operations: { search: "s", track: "t", resolve: "r", artwork: "a" } }] };
    assert.deepEqual(contract.missingRequirements({ client: ["media.audio"], capabilities: ["audio.library"] }, audio), []);
    assert.deepEqual(contract.missingRequirements({ client: ["media.audio"], capabilities: ["audio.library"] }, {}),
        [{ kind: "capability", name: "audio.library" }]);
    assert.deepEqual(contract.missingRequirements({ client: ["device.biometrics"], capabilities: ["future.thing"] }, providers),
        [{ kind: "client", name: "device.biometrics" }, { kind: "capability", name: "future.thing" }]);
});

test("a block's requires (change 14): left out unless this client offers every capability it names", () => {
    for (const name of contract.CLIENT_CAPABILITIES) {
        assert.ok(vocabulary.client_capabilities.reserved.includes(name), name);
    }
    assert.equal(contract.servesBlock({ type: "text", text: "x" }), true);
    // Mission Control's audio host applies every playback and player preference
    assert.equal(contract.servesBlock({ type: "toggle", requires: { client: ["media.audio-gapless", "media.audio-crossfade"] } }), true);
    assert.equal(contract.servesBlock({ type: "card", requires: { client: ["media.audio-theme", "media.audio-density", "media.audio-visualizer"] } }), true);
    assert.equal(contract.servesBlock({ type: "text", requires: { client: ["media.audio", "secure.screen"] } }), false);
    assert.equal(contract.servesBlock({ type: "text", requires: { client: ["device.biometrics"] } }), false);
});
