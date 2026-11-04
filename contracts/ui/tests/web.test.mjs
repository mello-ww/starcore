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
    for (const name of Object.keys(contract.CAPABILITY_VERSIONS)) {
        assert.ok(vocabulary.satellite_capabilities[name], name);
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
    assert.deepEqual(contract.missingRequirements({ client: ["device.biometrics"], capabilities: ["future.thing"] }, providers),
        [{ kind: "client", name: "device.biometrics" }, { kind: "capability", name: "future.thing" }]);
});
