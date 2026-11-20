// The choose action (UI contract 1.2, change 8), Mission Control's side: what it offers, what it
// sends for a row and for a new one, and how a 409 is asked. The dialog is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { chooseRows, runChoose } from "../ui/choose.js";

const action = {
    choose: {
        source: "playlists?editable=1",
        items: "$.playlists",
        item: { title: "$.name", subtitle: "$.line", image: "playlists/{$.id}/picture?size=120" },
        title: "Add to playlist",
        empty: "No playlists yet.",
        create: { label: "New playlist", field: "Name", route: "playlists", body: { name: "$value", tracks: ["$.id"] } },
    },
    route: "playlists/{$value.id}/add",
    body: { tracks: ["$.id"], ask: true },
    conflict: {
        confirm: "This song is already in this playlist. Add it again?",
        body: { tracks: ["$.id"], allow_duplicates: true },
    },
    then: "refresh",
};

const bindings = { data: { id: "t1", title: "One" }, page: {}, params: {}, state: {} };
const answer = { playlists: [{ id: 4, name: "Road", line: "3 songs" }, { id: 7, name: "Late", line: "1 song" }] };

function depsWith({ picked, fail, confirmed = true }) {
    const sent = [];
    const asked = [];
    let shown = null;
    return {
        sent,
        asked,
        get shown() { return shown; },
        load: async (route) => {
            assert.equal(route, "playlists?editable=1");
            return answer;
        },
        choose: async (offer) => {
            shown = offer;
            return picked(offer);
        },
        request: async (route, body) => {
            sent.push({ route, body });
            if (fail && sent.length === 1) {
                throw fail;
            }
            return { message: "Added." };
        },
        confirm: (text) => {
            asked.push(text);
            return confirmed;
        },
    };
}

test("the rows come from the source, with `$.` the source's row", () => {
    const rows = chooseRows(action.choose, answer, bindings);
    assert.deepEqual(rows.map((row) => [row.title, row.subtitle, row.image]), [
        ["Road", "3 songs", "playlists/4/picture?size=120"],
        ["Late", "1 song", "playlists/7/picture?size=120"],
    ]);
    assert.equal(rows[0].row, answer.playlists[0]);
    assert.deepEqual(chooseRows(action.choose, {}, bindings), []);
});

test("a picture outside the Satellite is not drawn", () => {
    const spec = { ...action.choose, item: { title: "$.name", image: "/api/core/{$.id}" } };
    assert.equal(chooseRows(spec, answer, bindings)[0].image, null);
});

test("a chosen row is $value, and `$.` stays the page's row", async () => {
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[1].row }) });
    const done = await runChoose(action, bindings, deps);
    assert.deepEqual(done, { result: { message: "Added." } });
    assert.deepEqual(deps.sent, [{ route: "playlists/7/add", body: { tracks: ["t1"], ask: true } }]);
    assert.equal(deps.shown.title, "Add to playlist");
    assert.equal(deps.shown.empty, "No playlists yet.");
    assert.deepEqual(deps.shown.create, { label: "New playlist", field: "Name" });
});

test("a new one is sent to the create route, with the typed text as $value", async () => {
    const deps = depsWith({ picked: () => ({ create: "Gym" }) });
    await runChoose(action, bindings, deps);
    assert.deepEqual(deps.sent, [{ route: "playlists", body: { name: "Gym", tracks: ["t1"] } }]);
});

test("a 409 asks, then sends the conflict's body to the same route", async () => {
    const conflict = Object.assign(new Error("This song is already in Road."), { status: 409 });
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[0].row }), fail: conflict });
    const done = await runChoose(action, bindings, deps);
    assert.deepEqual(done, { result: { message: "Added." } });
    assert.deepEqual(deps.asked, ["This song is already in this playlist. Add it again?"]);
    assert.deepEqual(deps.sent[1], { route: "playlists/4/add", body: { tracks: ["t1"], allow_duplicates: true } });
});

test("declining the question sends nothing more", async () => {
    const conflict = Object.assign(new Error("Already there."), { status: 409 });
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[0].row }), fail: conflict, confirmed: false });
    assert.equal(await runChoose(action, bindings, deps), null);
    assert.equal(deps.sent.length, 1);
});

test("without `conflict`, a 409 is the route's own error", async () => {
    const conflict = Object.assign(new Error("Already there."), { status: 409 });
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[0].row }), fail: conflict });
    const { conflict: _ignored, ...plain } = action;
    await assert.rejects(runChoose(plain, bindings, deps), /Already there/);
    assert.deepEqual(deps.asked, []);
});

test("any other error is thrown as it came", async () => {
    const broken = Object.assign(new Error("Playlist not found."), { status: 404 });
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[0].row }), fail: broken });
    await assert.rejects(runChoose(action, bindings, deps), /Playlist not found/);
    assert.deepEqual(deps.asked, []);
});

test("cancelling sends nothing", async () => {
    const deps = depsWith({ picked: () => null });
    assert.equal(await runChoose(action, bindings, deps), null);
    assert.deepEqual(deps.sent, []);
});

test("a route that leaves the Satellite is refused before anything is sent", async () => {
    const outside = { ...action, route: "/api/auth/{$value.id}" };
    const deps = depsWith({ picked: (offer) => ({ row: offer.rows[0].row }) });
    await assert.rejects(runChoose(outside, bindings, deps), /refused/);
    assert.deepEqual(deps.sent, []);
    const source = { ...action, choose: { ...action.choose, source: "../core" } };
    await assert.rejects(runChoose(source, bindings, depsWith({ picked: () => null })), /refused/);
});
