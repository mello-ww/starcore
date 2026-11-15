// The Satellites' real ui.json documents against Mission Control's own checks: each one is a
// document this client draws, and the Locked Folder's - a protected preview Photo opens through
// its section tile - binds its grid the way the renderer reads it: a tile with a preview loads
// it from the Satellite's own route, a tile without one shows its icon and loads nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import test from "node:test";

import { checkDocument, isSafeRoute, isVisible, resolve, resolveTemplate } from "../ui/contract.js";
import { itemKey, mediaKind, tileAction, tileIcon } from "../ui/gallery.js";

const NATIVE = new URL("../../satellites/native/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(`${name}/ui.json`, NATIVE), "utf-8"));
const documents = readdirSync(NATIVE).filter((name) => existsSync(new URL(`${name}/ui.json`, NATIVE)));

function blocksOf(page) {
    const found = [];
    const walk = (blocks) => (blocks || []).forEach((block) => {
        found.push(block);
        walk(block.blocks);
    });
    walk(page.blocks);
    return found;
}

test("every Satellite's document is one Mission Control draws", () => {
    assert.ok(documents.length >= 3, documents.join(", "));
    for (const name of documents) {
        assert.equal(checkDocument(read(name)), null, name);
    }
});

test("the Locked Folder's grid: a preview from its own route, an icon and nothing loaded without one", () => {
    const document = read("locked_folder");
    const grid = blocksOf(document.pages.vault).find((block) => block.type === "media-grid");
    const picture = { path: "trips/beach.png", preview: "file", kind: "image", icon: null, movable: true };
    const note = { path: "secret.txt", preview: null, kind: null, icon: "file", movable: false };

    const image = (item) => resolveTemplate(grid.item.image, { data: item });
    assert.equal(image(picture), "media/file?path=trips%2Fbeach.png");
    assert.equal(isSafeRoute(image(picture)), true);
    assert.equal(isSafeRoute(image(note)), false, "an empty segment: nothing is fetched");
    assert.equal(tileIcon(grid, { data: note }), "file");
    assert.equal(mediaKind(resolve(grid.item.kind, { data: picture })), "image");
    assert.equal(itemKey(grid, note, 0, {}), "secret.txt");
    // a tile opens the viewer: the grid has no tile action of its own
    assert.equal(tileAction(grid, { data: picture }, () => true), null);

    const shown = (item) => grid.viewer.actions.filter((entry) => entry.visible === undefined
        || isVisible(resolve(entry.visible, { data: item }))).map((entry) => entry.label);
    assert.deepEqual(shown(picture), ["Move to Photos", "Download", "Delete forever"]);
    assert.deepEqual(shown(note), ["Download", "Delete forever"]);
    assert.equal(resolveTemplate(grid.viewer.image, { data: picture }), "media/file?path=trips%2Fbeach.png");
});

test("Photo's albums open a section tile through the section action, and name no Satellite", () => {
    const document = read("photo");
    const grid = blocksOf(document.pages.albums).find((block) => block.type === "media-grid");
    const all = () => true;
    const section = { id: "section-Vaulty", section: "Vaulty", icon: "lock" };
    assert.deepEqual(tileAction(grid, { data: section }, all), { section: "$.section" });
    assert.equal(tileAction(grid, { data: { id: "album-1" } }, all).navigate, "album");
    assert.equal(tileIcon(grid, { data: section }), "lock");
});
