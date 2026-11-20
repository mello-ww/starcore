// A media-list's reorder (UI contract 1.2, change 8), Mission Control's side: how the rows move
// and where a dragged row lands. The dragging itself is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { moveItem, shiftFor, targetIndex } from "../ui/reorder.js";

test("an item moves to its final index, in place", () => {
    const items = ["a", "b", "c", "d"];
    assert.equal(moveItem(items, 0, 2), true);
    assert.deepEqual(items, ["b", "c", "a", "d"]);
    assert.equal(moveItem(items, 3, 0), true);
    assert.deepEqual(items, ["d", "b", "c", "a"]);
    assert.equal(moveItem(items, 2, 2), false);
    assert.equal(moveItem(items, 9, 0), false);
    assert.deepEqual(items, ["d", "b", "c", "a"]);
});

test("moving back undoes a move", () => {
    const items = ["a", "b", "c", "d", "e"];
    moveItem(items, 1, 3);
    moveItem(items, 3, 1);
    assert.deepEqual(items, ["a", "b", "c", "d", "e"]);
});

test("a dragged row lands where it was let go, within the list", () => {
    assert.equal(targetIndex(1, 0, 56, 5), 1);
    assert.equal(targetIndex(1, 30, 56, 5), 2);
    assert.equal(targetIndex(1, 120, 56, 5), 3);
    assert.equal(targetIndex(1, -200, 56, 5), 0);
    assert.equal(targetIndex(1, 900, 56, 5), 4);
    assert.equal(targetIndex(2, 40, 0, 5), 2);
});

test("the rows between step aside while one is held", () => {
    // row 1 held over row 3: rows 2 and 3 step up
    assert.deepEqual([0, 1, 2, 3, 4].map((index) => shiftFor(index, 1, 3, 56)), [0, 0, -56, -56, 0]);
    // row 3 held over row 1: rows 1 and 2 step down
    assert.deepEqual([0, 1, 2, 3, 4].map((index) => shiftFor(index, 3, 1, 56)), [0, 56, 56, 0, 0]);
    assert.deepEqual([0, 1, 2].map((index) => shiftFor(index, 1, 1, 56)), [0, 0, 0]);
});
