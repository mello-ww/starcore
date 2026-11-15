// Protected documents (UI contract 1.2), Mission Control's side: which store a document may be
// gated by, what a status answer means, and the gate itself - the prompt for a full unlock, keep
// while shown, a 403 or a refused keep asking again, and the lock on leaving. The dialog itself
// is checked in the browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROTECTED_CAPABILITIES } from "../ui/contract.js";
import { createVaultGate, gateState, KEEP_SECONDS, LEAVE_GRACE_SECONDS, protectedProvider } from "../ui/vault.js";

const vocabulary = JSON.parse(readFileSync(new URL("../../contracts/ui/vocabulary.json", import.meta.url), "utf-8"));
const OPERATIONS = { status: "status", unlock: "unlock", lock: "lock", keep: "keep" };
const STORE = { satellite: "Store", version: 1, enabled: true, operations: { ...OPERATIONS, move_in: "move_in" } };
const DOCUMENT = { protected: { capability: "media.vault", setup: "setup" } };
const SET_UP = { configured: true, pin_set: true, pin_unreadable: false, security: { problem: null } };
const failure = (status, message, payload) => Object.assign(new Error(message), { status, payload });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("it gates documents by exactly the stores the shared vocabulary lists", () => {
    const shared = Object.fromEntries(Object.entries(vocabulary.protected_capabilities).filter(([name]) => !name.startsWith("_")));
    assert.deepEqual(PROTECTED_CAPABILITIES, shared);
});

test("the store is the document's own Satellite's, offering every operation the gate calls", () => {
    const catalog = { "media.vault": [STORE] };
    assert.equal(protectedProvider(DOCUMENT, catalog, "Store"), STORE);
    assert.equal(protectedProvider(DOCUMENT, catalog, "Other"), null, "another Satellite's store never opens this document");
    assert.equal(protectedProvider(DOCUMENT, { "media.vault": [{ ...STORE, operations: { status: "s", unlock: "u", lock: "l" } }] }, "Store"),
        null, "a store without keep can't be kept open, so it isn't shown");
    assert.equal(protectedProvider(DOCUMENT, { "media.vault": [{ ...STORE, version: 2 }] }, "Store"), null);
    assert.equal(protectedProvider({ protected: { capability: "files.browse", setup: "setup" } }, catalog, "Store"), null);
    assert.equal(protectedProvider({ protected: { capability: "__proto__", setup: "setup" } }, catalog, "Store"), null);
    assert.equal(protectedProvider({}, catalog, "Store"), null);
});

test("what a status answer means", () => {
    assert.equal(gateState({ ...SET_UP, unlocked: true }), "open");
    assert.equal(gateState({ ...SET_UP, unlocked: false }), "locked");
    assert.equal(gateState({ ...SET_UP, configured: false }), "setup");
    assert.equal(gateState({ ...SET_UP, pin_set: false }), "setup");
    assert.equal(gateState({ ...SET_UP, pin_unreadable: true }), "setup");
    assert.equal(gateState({ ...SET_UP, security: { problem: "the PIN file is world-readable" } }), "setup");
    assert.equal(gateState(null), "failed");
    assert.equal(gateState([]), "failed");
});

function fakeTimers() {
    let now = 0;
    let id = 0;
    const pending = new Map();
    const add = (fn, ms, every) => {
        id += 1;
        pending.set(id, { fn, at: now + ms, every });
        return id;
    };
    return {
        setTimeout: (fn, ms) => add(fn, ms, 0),
        setInterval: (fn, ms) => add(fn, ms, ms),
        clearTimeout: (key) => pending.delete(key),
        clearInterval: (key) => pending.delete(key),
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                const next = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) {
                    break;
                }
                const [key, timer] = next;
                now = timer.at;
                if (timer.every) {
                    timer.at += timer.every;
                } else {
                    pending.delete(key);
                }
                timer.fn();
                await flush();
            }
            now = end;
        },
    };
}

/** A gate over a fake store: `status` is what it answers (changeable), `pins` the PINs typed in
 * turn (null cancels), and every request, prompt, lock and state is recorded. */
function setup({ status = { ...SET_UP, unlocked: false }, pins = [], unlock } = {}) {
    const world = { status, calls: [], prompts: [], locks: [], states: [], pins: [...pins], keep: null };
    const timers = fakeTimers();
    const request = async (route, body) => {
        world.calls.push(body === undefined ? route : `${route} ${JSON.stringify(body)}`);
        if (route === "status") {
            return world.status;
        }
        if (route === "unlock") {
            if (unlock) {
                return unlock(body);
            }
            world.status = { ...world.status, unlocked: true };
            return { unlocked: true, expires_at: "later" };
        }
        if (route === "keep") {
            if (world.keep) {
                throw world.keep;
            }
            return { expires_at: "later" };
        }
        throw new Error(`unexpected ${route}`);
    };
    const prompt = ({ signal, ...asked }) => {
        world.prompts.push(asked);
        if (!world.pins.length) {
            // left open until the gate closes it
            return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
        }
        return Promise.resolve(world.pins.shift());
    };
    const gate = createVaultGate({
        provider: STORE, request, prompt, timers,
        lock: (route) => world.locks.push(route),
        onChange: (state, why) => world.states.push(why ? `${state}: ${why}` : state),
    });
    return { gate, world, timers };
}

test("unlocked already: it opens, and keeps the unlock alive only while shown", async () => {
    const { gate, world, timers } = setup({ status: { ...SET_UP, unlocked: true } });
    await gate.check();
    assert.deepEqual(world.states, ["checking", "open"]);
    assert.deepEqual(world.prompts, []);
    await timers.advance(KEEP_SECONDS * 1000 * 3);
    assert.equal(world.calls.filter((call) => call.startsWith("keep")).length, 3);
    gate.setHidden(true);
    await timers.advance((LEAVE_GRACE_SECONDS - 1) * 1000);
    gate.setHidden(false);
    await timers.advance(KEEP_SECONDS * 1000);
    assert.deepEqual(world.locks, [], "back within the grace: still open");
    assert.equal(world.calls.filter((call) => call.startsWith("keep")).length, 4);
});

test("locked: its own prompt asks for a full unlock, a wrong PIN asks again, the PIN is kept nowhere", async () => {
    const { gate, world } = setup({ pins: ["1111", "2468"], unlock: (body) => {
        if (body.pin !== "2468") {
            throw failure(401, "incorrect PIN");
        }
        world.status = { ...world.status, unlocked: true };
        return { unlocked: true, expires_at: "later" };
    } });
    await gate.check();
    assert.deepEqual(world.prompts, [
        { purpose: "unlock", error: null, wait: 0 },
        { purpose: "unlock", error: "Incorrect PIN.", wait: 0 },
    ]);
    assert.deepEqual(world.calls, ["status", 'unlock {"pin":"1111"}', 'unlock {"pin":"2468"}']);
    assert.deepEqual(world.states, ["checking", "locked", "open"]);
    assert.equal(gate.state(), "open");
});

test("a lockout's wait reaches the prompt", async () => {
    const { gate, world } = setup({ pins: ["1111", null], unlock: () => {
        throw failure(429, "too many attempts", { retry_after: 30 });
    } });
    await gate.check();
    assert.deepEqual(world.prompts[1], { purpose: "unlock", error: "too many attempts", wait: 30 });
    assert.equal(gate.state(), "locked");
});

test("cancelled: it stays locked, and unlocking asks again", async () => {
    const { gate, world } = setup({ pins: [null, "2468"] });
    await gate.check();
    assert.equal(gate.state(), "locked");
    assert.equal(world.calls.filter((call) => call.startsWith("unlock")).length, 0);
    await gate.unlock();
    assert.equal(gate.state(), "open");
});

test("not set up: the setup page, no prompt, and nothing to lock", async () => {
    const { gate, world } = setup({ status: { ...SET_UP, pin_set: false, unlocked: false } });
    await gate.check();
    assert.deepEqual(world.states, ["checking", "setup"]);
    assert.deepEqual(world.prompts, []);
    gate.dispose();
    assert.deepEqual(world.locks, []);
});

test("a refused keep or a 403 asks again: locked again means the prompt, not an error", async () => {
    const { gate, world, timers } = setup({ status: { ...SET_UP, unlocked: true } });
    await gate.check();
    world.status = { ...SET_UP, unlocked: false };  // the server's idle time, or a lock elsewhere
    world.keep = failure(403, "locked");
    await timers.advance(KEEP_SECONDS * 1000);
    assert.deepEqual(world.states, ["checking", "open", "locked"]);
    assert.equal(world.prompts.length, 1);

    // a quiet check that finds it still open changes nothing (a 403 for another reason)
    const second = setup({ status: { ...SET_UP, unlocked: true } });
    await second.gate.check();
    await second.gate.check({ quiet: true });
    assert.deepEqual(second.world.states, ["checking", "open"]);
});

test("hidden past the grace, it locks; shown again, it asks", async () => {
    const { gate, world, timers } = setup({ status: { ...SET_UP, unlocked: true } });
    await gate.check();
    gate.setHidden(true);
    await timers.advance(LEAVE_GRACE_SECONDS * 1000);
    assert.deepEqual(world.locks, ["lock"]);
    assert.equal(gate.state(), "locked");
    const keeps = world.calls.filter((call) => call.startsWith("keep")).length;
    await timers.advance(KEEP_SECONDS * 1000 * 2);
    assert.equal(world.calls.filter((call) => call.startsWith("keep")).length, keeps, "no keep once locked");
    world.status = { ...SET_UP, unlocked: false };
    gate.setHidden(false);
    await flush();
    assert.equal(world.prompts.length, 1);
});

test("leaving closes an open prompt, and an answer that arrives after it is dropped", async () => {
    const { gate, world } = setup();
    const checking = gate.check();
    await flush();
    assert.equal(world.prompts.length, 1, "the prompt is open");
    gate.leave();
    await checking;
    assert.equal(gate.state(), "locked");
    assert.deepEqual(world.locks, ["lock"]);
    assert.equal(world.calls.filter((call) => call.startsWith("unlock")).length, 0);
});

test("closing the document locks it, and nothing changes after", async () => {
    const { gate, world, timers } = setup({ status: { ...SET_UP, unlocked: true } });
    await gate.check();
    gate.dispose();
    assert.deepEqual(world.locks, ["lock"]);
    const states = world.states.length;
    await timers.advance(KEEP_SECONDS * 1000 * 2);
    await gate.check();
    assert.equal(world.states.length, states);
});

test("StarCore not answering is a failure to show, with nothing behind it", async () => {
    const { gate, world } = setup();
    world.status = null;
    await gate.check();
    assert.equal(gate.state(), "failed");
});
