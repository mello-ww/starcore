// A row's own actions (UI contract 1.2 `quick`, `menu`, `then: "update"`, `item.audio`) and what
// Back finds again, Mission Control's side. The drawing is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { createEntries, groupOf, isPlayingRow, mergeItem, rowMenu, rowQuick } from "../ui/rows.js";

const block = {
    type: "media-list", items: "$.tracks",
    item: { title: "$.title", key: "$.id", audio: "$.id", group: "$.disc" },
    quick: [
        { label: "Like", icon: "heart", visible: "$.not_liked", action: { route: "favorites", then: "update" } },
        { label: "Unlike", icon: "heart", style: "primary", visible: "$.liked", action: { route: "favorites", then: "update" } },
    ],
    menu: [
        { label: "Play next", action: { play: { tracks: ["$"], queue: "next" } } },
        { label: "Go to album", visible: "$.album_id", action: { navigate: "album", params: { id: "$.album_id" } } },
        { label: "Share", action: { share: "tracks/{$.id}/file" } },
        { label: "Open in the old page", action: { own: "track" } },
    ],
};

const scopeOf = (data) => ({ data, page: {}, params: {}, state: {} });
const everything = () => true;

test("a heart pair draws one heart, and the answer's item turns it over", () => {
    const row = { id: "t1", title: "One", liked: false, not_liked: true };
    assert.deepEqual(rowQuick(block, scopeOf(row), everything).map((entry) => entry.label), ["Like"]);
    assert.equal(mergeItem(row, { item: { liked: true, not_liked: false } }), true);
    assert.deepEqual(rowQuick(block, scopeOf(row), everything).map((entry) => entry.label), ["Unlike"]);
    assert.equal(row.id, "t1", "the row keeps its key");
});

test("an answer without an item object changes nothing", () => {
    const row = { id: "t1", liked: false };
    for (const answer of [null, {}, { item: null }, { item: [1] }, { item: "liked" }]) {
        assert.equal(mergeItem(row, answer), false);
    }
    assert.deepEqual(row, { id: "t1", liked: false });
});

test("a menu leaves out what is hidden and what this client can't run", () => {
    const canRun = (action) => action.share === undefined && action.own === undefined;
    const withAlbum = scopeOf({ id: "t1", album_id: "a1" });
    assert.deepEqual(rowMenu(block, withAlbum, canRun).map((entry) => entry.label), ["Play next", "Go to album"]);
    assert.deepEqual(rowMenu(block, scopeOf({ id: "t2" }), canRun).map((entry) => entry.label), ["Play next"]);
    assert.deepEqual(rowMenu(block, withAlbum, () => false), [], "nothing left: no menu");
    assert.deepEqual(rowMenu({ type: "media-list" }, withAlbum, everything), []);
});

test("the playing row is the one whose audio binding is the current track", () => {
    assert.equal(isPlayingRow(block, scopeOf({ id: "t1" }), "t1"), true);
    assert.equal(isPlayingRow(block, scopeOf({ id: 7 }), "7"), true);
    assert.equal(isPlayingRow(block, scopeOf({ id: "t2" }), "t1"), false);
    assert.equal(isPlayingRow(block, scopeOf({ id: "t1" }), null), false, "nothing plays, or another Satellite's track");
    assert.equal(isPlayingRow({ item: { title: "$.title" } }, scopeOf({ id: "t1" }), "t1"), false);
});

test("a group's label is its formatted value, empty for none", () => {
    assert.equal(groupOf(block, scopeOf({ disc: 2 }), (value) => `Disc ${value}`), "Disc 2");
    assert.equal(groupOf(block, scopeOf({ disc: "" })), "");
    assert.equal(groupOf({ item: {} }, scopeOf({ disc: 2 })), "");
});

test("each history entry keeps what it left, its scroll position too, the newest ones only", () => {
    const entries = createEntries(2);
    entries.save("a", { page: "library", scroll: 0 });
    entries.scroll("a", 4200);
    assert.equal(entries.get("a").scroll, 4200);
    entries.save("b", { page: "album" });
    entries.save("c", { page: "artist" });
    assert.equal(entries.get("a"), null, "the oldest went");
    assert.equal(entries.get("c").page, "artist");
    entries.clear();
    assert.equal(entries.get("c"), null);
});
