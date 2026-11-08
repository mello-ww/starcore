// Moving a photo into the Locked Folder from Photo's own web page: the vault is locked again
// after every move attempt, and a lock that can't be sent is never reported as success.
// Run: node --test satellites/native/photo/tests/lockedMove.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockAgain, moveIntoLockedFolder, moveNotice, retryLockLater } from "../mission_control/lockedMove.js";

const LOCKED = { configured: true, pin_set: true, unlocked: false, session_timeout_seconds: 900 };

function fakeApi({ status = LOCKED, move = async () => ({ moved: [{ id: "p1" }], failed: [] }), lock = async () => ({ locked: true }) } = {}) {
    const calls = [];
    return {
        calls,
        url: (path) => `/api/satellites/x${path}`,
        get: async (path) => { calls.push(["GET", path]); return status; },
        post: async (path, body) => {
            calls.push(["POST", path, body]);
            if (path === "/move_in") { return move(body); }
            if (path === "/lock") { return lock(); }
            throw new Error(`unexpected ${path}`);
        },
    };
}
const unlocked = async () => true;
const posts = (api, path) => api.calls.filter(([method, at]) => method === "POST" && at === path).length;

test("a move after the PIN locks again and reports success", async () => {
    const api = fakeApi();
    const result = await moveIntoLockedFolder(api, ["p1"], { requestUnlock: unlocked });
    assert.equal(result.outcome, "moved");
    assert.equal(result.locked, true);
    assert.equal(posts(api, "/lock"), 1);
    assert.deepEqual(moveNotice(result), { text: "Moved to the Locked Folder.", isError: false });
});

test("a failed move still locks again (F1)", async () => {
    for (const move of [
        async () => ({ moved: [], failed: [{ id: "p1", reason: "the disk is full" }] }),
        async () => { throw new Error("the Locked Folder is being encrypted"); },
    ]) {
        const api = fakeApi({ move });
        const result = await moveIntoLockedFolder(api, ["p1"], { requestUnlock: unlocked });
        assert.equal(result.outcome, "failed");
        assert.equal(posts(api, "/lock"), 1);
        assert.equal(moveNotice(result).isError, true);
    }
});

test("a lock that can't be sent is never a plain success, and says when it locks by itself", async () => {
    const api = fakeApi({ lock: async () => { throw new Error("offline"); } });
    const at = Date.UTC(2026, 10, 8, 12, 0, 0);
    const result = await moveIntoLockedFolder(api, ["p1"], { requestUnlock: unlocked, now: () => at });
    assert.equal(result.outcome, "moved");
    assert.equal(result.locked, false);
    assert.equal(result.locksAt.getTime(), at + 900 * 1000); // a fresh unlock: the session timeout from now
    const notice = moveNotice(result, (when) => when.toISOString());
    assert.equal(notice.isError, true);
    assert.match(notice.text, /couldn't be locked again: it locks by itself at 2026-11-08T12:15:00.000Z/);

    const failed = moveNotice({ ...result, outcome: "failed", error: new Error("no such photo") }, () => "12:15");
    assert.match(failed.text, /could not be moved: no such photo\. The Locked Folder couldn't be locked again/);
});

test("an unlock that was already open ends when the server said it would", async () => {
    const expires = "2026-11-08T12:07:00+00:00";
    const result = await lockAgain(
        { post: async () => { throw new Error("offline"); } },
        { ...LOCKED, unlocked: true, expires_at: expires },
    );
    assert.deepEqual(result, { locked: false, locksAt: new Date(expires) });
});

test("an already unlocked session moves without a prompt, and is locked again", async () => {
    const api = fakeApi({ status: { ...LOCKED, unlocked: true } });
    let asked = false;
    const result = await moveIntoLockedFolder(api, ["p1"], { requestUnlock: async () => { asked = true; return true; } });
    assert.equal(asked, false);
    assert.equal(result.outcome, "moved");
    assert.equal(posts(api, "/lock"), 1);
});

test("cancelling the prompt, or no PIN yet, moves nothing and has nothing to lock", async () => {
    const cancelled = fakeApi();
    assert.equal((await moveIntoLockedFolder(cancelled, ["p1"], { requestUnlock: async () => false })).outcome, "cancelled");
    assert.equal(posts(cancelled, "/move_in") + posts(cancelled, "/lock"), 0);

    const setup = fakeApi({ status: { configured: true, pin_set: false } });
    assert.equal((await moveIntoLockedFolder(setup, ["p1"], { requestUnlock: unlocked })).outcome, "setup");
    assert.equal(posts(setup, "/move_in") + posts(setup, "/lock"), 0);
    assert.equal(moveNotice({ outcome: "cancelled" }), null);
});

function fakeWindow() {
    const listeners = new Map();
    const beacons = [];
    return {
        beacons,
        navigator: { sendBeacon: (url) => { beacons.push(url); return true; } },
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: (name, listener) => { if (listeners.get(name) === listener) { listeners.delete(name); } },
        fire: (name) => listeners.get(name)?.(),
        has: (name) => listeners.has(name),
    };
}

test("the lock is tried again once when back online", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    retryLockLater(api, win);
    win.fire("online");
    win.fire("online");
    win.fire("pagehide");
    await Promise.resolve();
    assert.equal(posts(api, "/lock"), 1);
    assert.deepEqual(win.beacons, []);
    assert.equal(win.has("online") || win.has("pagehide"), false);
});

test("...or with a beacon as the page goes away", () => {
    const api = fakeApi();
    const win = fakeWindow();
    retryLockLater(api, win);
    win.fire("pagehide");
    win.fire("online");
    assert.deepEqual(win.beacons, ["/api/satellites/x/lock"]);
    assert.equal(posts(api, "/lock"), 0);
});
