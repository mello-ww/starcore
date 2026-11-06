// The media-grid's pure helpers (UI contract 1.2), Mission Control's side: what a tile's kind
// and key resolve to, and a video's duration badge. The grid itself is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { clock, GRID_PAGE, GRID_SIZES, gridSize, gridSizeKey, itemKey, mediaKind } from "../ui/gallery.js";

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

test("a person's choice of thumbnail size wins over the document's, when it is one of the sizes", () => {
    assert.deepEqual(GRID_SIZES, ["small", "medium", "large"]);
    assert.equal(gridSize({ size: "large" }, "small"), "small");
    assert.equal(gridSize({ size: "large" }, null), "large");
    assert.equal(gridSize({}, null), "medium");
    assert.equal(gridSize({ size: "small" }, "huge"), "small");  // a stored value from elsewhere
});

test("each grid remembers its own size", () => {
    assert.equal(gridSizeKey({ id: "library" }), "media-grid:library:size");
    assert.equal(gridSizeKey({}), "media-grid:grid:size");
    assert.notEqual(gridSizeKey({ id: "library" }), gridSizeKey({ id: "trash" }));
});
