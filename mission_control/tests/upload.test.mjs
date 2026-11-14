// The upload action (UI contract 1.2), Mission Control's side: each file in turn, a conflict
// asked about file by file, and a report that never shows part of a selection as all of it.
// The dialog and the streamed fetch themselves are checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { chooseFiles, runUploads, uploadReport, uploadValue } from "../ui/upload.js";

const action = {
    upload: { multiple: true },
    route: "upload?name={$value.name}",
    conflict: { confirm: "Replace it?", route: "upload?name={$value.name}&overwrite=1" },
};

function host(answers, { replace = true } = {}) {
    const sent = [];
    const asked = [];
    return {
        sent,
        asked,
        url: (template, value) => (template.startsWith("..") ? null
            : `/api/satellites/Any/${template.replace("{$value.name}", encodeURIComponent(value.name))}`),
        send: async (url, file) => {
            sent.push([url, file.name]);
            const answer = answers.shift();
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
        confirm: async (value, text) => {
            asked.push([value.name, text]);
            return replace;
        },
    };
}

test("a picked file's $value is its safe name and its size", () => {
    assert.deepEqual(uploadValue({ name: "notes.txt", size: 12 }), { name: "notes.txt", size: 12 });
    assert.deepEqual(uploadValue({ name: "../a:b.txt", size: 3 }), { name: "_a_b.txt", size: 3 });
    assert.deepEqual(uploadValue({ name: "", size: -1 }), { name: "upload", size: 0 });
});

test("each file is sent in turn, and every one that arrived is reported", async () => {
    const files = [{ name: "a.txt", size: 1 }, { name: "b c.txt", size: 2 }];
    const fake = host([{ status: 200, payload: {} }, { status: 200, payload: {} }]);
    const result = await runUploads(files, action, fake);
    assert.deepEqual(fake.sent, [
        ["/api/satellites/Any/upload?name=a.txt", "a.txt"],
        ["/api/satellites/Any/upload?name=b%20c.txt", "b c.txt"],
    ]);
    assert.deepEqual(result, { uploaded: ["a.txt", "b c.txt"], skipped: [], failed: [] });
    assert.deepEqual(uploadReport(result), { text: "Uploaded 2 files.", kind: "notice" });
    assert.deepEqual(uploadReport({ uploaded: ["a.txt"], skipped: [], failed: [] }), { text: "Uploaded a.txt.", kind: "notice" });
});

test("a 409 asks, naming the file, then retries on the conflict route", async () => {
    const fake = host([{ status: 409, payload: { error: "exists" } }, { status: 200, payload: {} }]);
    const result = await runUploads([{ name: "a.txt", size: 1 }], action, fake);
    assert.deepEqual(fake.asked, [["a.txt", "Replace it?"]]);
    assert.equal(fake.sent[1][0], "/api/satellites/Any/upload?name=a.txt&overwrite=1");
    assert.deepEqual(result.uploaded, ["a.txt"]);
});

test("declining a replacement skips that file and goes on with the next", async () => {
    const fake = host([{ status: 409, payload: {} }, { status: 200, payload: {} }], { replace: false });
    const result = await runUploads([{ name: "a.txt", size: 1 }, { name: "b.txt", size: 1 }], action, fake);
    assert.equal(fake.sent.length, 2);
    assert.deepEqual(result, { uploaded: ["b.txt"], skipped: ["a.txt"], failed: [] });
    assert.deepEqual(uploadReport(result), { text: "Uploaded 1 of 2 files. Kept the existing a.txt.", kind: "notice" });
});

test("without a conflict route a 409 is that file's failure", async () => {
    const fake = host([{ status: 409, payload: { error: "'a.txt' already exists" } }]);
    const result = await runUploads([{ name: "a.txt", size: 1 }], { route: "inbox?name={$value.name}" }, fake);
    assert.deepEqual(fake.asked, []);
    assert.deepEqual(result.failed, [{ name: "a.txt", error: "'a.txt' already exists" }]);
    assert.deepEqual(uploadReport(result), { text: "Could not upload a.txt ('a.txt' already exists).", kind: "error" });
});

test("a failure, a lost connection or a route leaving the Satellite is reported, never as done", async () => {
    const fake = host([{ status: 413, payload: { error: "too large" } }, new Error("network down"), { status: 500, payload: null }]);
    const files = [{ name: "big.iso", size: 9 }, { name: "b.txt", size: 1 }, { name: "c.txt", size: 1 }, { name: "d.txt", size: 1 }];
    const result = await runUploads(files, { route: "upload?name={$value.name}" }, fake);
    assert.deepEqual(result.failed, [
        { name: "big.iso", error: "too large" },
        { name: "b.txt", error: "network down" },
        { name: "c.txt", error: "the server answered 500" },
        { name: "d.txt", error: "the upload failed" },
    ]);
    const report = uploadReport(result);
    assert.equal(report.kind, "error");
    assert.equal(report.text, "Uploaded 0 of 4 files. Could not upload big.iso (too large); b.txt (network down); "
        + "c.txt (the server answered 500) and 1 more.");

    const outside = host([]);
    const refused = await runUploads([{ name: "a.txt", size: 1 }], { route: "../x" }, outside);
    assert.equal(outside.sent.length, 0);
    assert.match(refused.failed[0].error, /outside its Satellite/);
});

function fakeDialog() {
    const listeners = {};
    const windowListeners = {};
    const input = {
        files: null,
        removed: false,
        clicked: 0,
        addEventListener: (name, listener) => { listeners[name] = listener; },
        click() { this.clicked += 1; },
        remove() { this.removed = true; },
    };
    const doc = { createElement: () => input, body: { appendChild: () => {} } };
    const win = {
        addEventListener: (name, listener) => { windowListeners[name] = listener; },
        removeEventListener: (name) => { delete windowListeners[name]; },
    };
    return { input, listeners, windowListeners, doc, win };
}

test("the browser's own dialog: what was chosen, or nothing when it was closed", async () => {
    const chosen = fakeDialog();
    const picking = chooseFiles({ multiple: true }, chosen.doc, chosen.win);
    assert.equal(chosen.input.type, "file");
    assert.equal(chosen.input.multiple, true);
    assert.equal(chosen.input.clicked, 1);
    chosen.input.files = [{ name: "a.txt" }];
    chosen.listeners.change();
    assert.deepEqual(await picking, [{ name: "a.txt" }]);
    assert.equal(chosen.input.removed, true);
    assert.equal(chosen.windowListeners.focus, undefined);

    const closed = fakeDialog();
    const cancelled = chooseFiles({}, closed.doc, closed.win);
    assert.equal(closed.input.multiple, false);
    closed.listeners.cancel();
    assert.deepEqual(await cancelled, []);
});
