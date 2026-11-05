// The media-grid's pure helpers (UI contract 1.2), Mission Control's side: what a tile's kind
// and key resolve to, and a video's duration badge. The grid itself is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { clock, GRID_PAGE, itemKey, mediaKind } from "../ui/gallery.js";

test("a tile is a video only when its kind says so", () => {
    assert.equal(mediaKind("video"), "video");
    assert.equal(mediaKind("image"), "image");
    assert.equal(mediaKind("audio"), "image");
    assert.equal(mediaKind(null), "image");
});

test("an item's key is its key binding, else its position", () => {
    const block = { item: { key: "$.id" } };
    assert.equal(itemKey(block, { id: 7 }, 0, {}), "7");
    assert.equal(itemKey(block, { id: null }, 3, {}), "#3");
    assert.equal(itemKey({ item: {} }, { id: 7 }, 2, {}), "#2");
});

test("a video's badge reads like a player's clock", () => {
    assert.equal(clock(5), "0:05");
    assert.equal(clock(65), "1:05");
    assert.equal(clock(3725), "1:02:05");
    assert.equal(clock(null), "0:00");
});

test("a page of tiles matches the app's", () => {
    assert.equal(GRID_PAGE, 60);
});
