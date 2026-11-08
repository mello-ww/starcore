// The secure action (UI contract 1.2), Mission Control's side: which provider it runs on, the
// references it sends, and the unlock flow - a grant for exactly these items, asked with the
// client's own prompt, never an unlock. The dialog itself is checked in the browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { references, runSecure, SECURE_OPERATIONS, secureProvider } from "../ui/secure.js";

const vocabulary = JSON.parse(readFileSync(new URL("../../contracts/ui/vocabulary.json", import.meta.url), "utf-8"));
const VAULT = { satellite: "Vault", version: 1, enabled: true,
    operations: { status: "status", unlock: "unlock", lock: "lock", move_in: "move_in" } };
const GALLERY = { satellite: "Gallery", version: 1, enabled: true, operations: { list: "media", thumbnail: "thumbs", resolve: "media/resolve" } };
const CATALOG = { "media.vault": [VAULT], "media.gallery": [GALLERY] };
const MOVE = { secure: { capability: "media.vault", operation: "move_in" }, item: "$.id" };

test("it runs exactly the operations the shared vocabulary allows", () => {
    const shared = Object.fromEntries(Object.entries(vocabulary.secure_operations).filter(([name]) => !name.startsWith("_")));
    assert.deepEqual(SECURE_OPERATIONS, shared);
});

test("it runs only for the gallery provider's own document, on an enabled provider offering it", () => {
    assert.equal(secureProvider(MOVE, CATALOG, "Gallery"), VAULT);
    assert.equal(secureProvider(MOVE, CATALOG, "Other"), null, "another Satellite's document has no gallery items of its own");
    assert.equal(secureProvider({ ...MOVE, secure: { capability: "media.vault", operation: "move_out" } }, CATALOG, "Gallery"), null);
    assert.equal(secureProvider(MOVE, { ...CATALOG, "media.vault": [{ ...VAULT, enabled: false }] }, "Gallery"), null);
    assert.equal(secureProvider(MOVE, { "media.gallery": [GALLERY] }, "Gallery"), null);
    assert.equal(secureProvider(MOVE, { ...CATALOG, "media.vault": [{ ...VAULT, operations: { status: "status", move_in: "move_in" } }] }, "Gallery"), null);
    assert.equal(secureProvider({ route: "x" }, CATALOG, "Gallery"), null);
});

test("references name the document's own Satellite, once per item", () => {
    assert.deepEqual(references("Gallery", ["a", 7, "a", null, ""]), [
        { provider: "Gallery", capability: "media.gallery", id: "a" },
        { provider: "Gallery", capability: "media.gallery", id: "7" },
    ]);
});

function server({ status = { configured: true, pin_set: true, unlocked: false }, unlock, move } = {}) {
    const calls = [];
    const request = async (route, body) => {
        calls.push({ route, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
        if (route === "status") { return status; }
        if (route === "unlock") { return unlock ? unlock(body) : { unlocked: false, grant: "g-1", expires_at: "later" }; }
        if (route === "move_in") { return move ? move(body) : { moved: body.items.map(({ id }) => ({ id })), failed: [] }; }
        throw new Error(`unexpected ${route}`);
    };
    return { calls, request };
}
const run = (srv, ids, prompt) => runSecure({ action: MOVE, ids, satellite: "Gallery", provider: VAULT, request: srv.request, prompt });
const failure = (status, message, payload) => Object.assign(new Error(message), { status, payload });

test("locked: one prompt asks for a grant for exactly these items, then moves them with it", async () => {
    const srv = server();
    const prompts = [];
    const result = await run(srv, ["a", "b", "a"], async (asked) => { prompts.push(asked); return "2468"; });
    assert.equal(result.outcome, "done");
    assert.equal(result.text, "Moved 2 items.");
    assert.deepEqual(prompts, [{ count: 2, error: null, wait: 0 }]);
    const [, unlock, move] = srv.calls;
    assert.deepEqual(unlock, { route: "unlock", body: { pin: "2468", for: { operation: "move_in", items: references("Gallery", ["a", "b"]) } } });
    assert.deepEqual(move, { route: "move_in", body: { items: references("Gallery", ["a", "b"]), grant: "g-1" } });
    assert.ok(!JSON.stringify(move).includes("2468"), "the PIN goes to the unlock only");
    assert.equal(srv.calls.filter(({ route }) => route === "lock").length, 0, "a grant opens nothing, so nothing is locked again");
});

test("already unlocked: no prompt and no grant", async () => {
    const srv = server({ status: { configured: true, pin_set: true, unlocked: true } });
    const result = await run(srv, ["a"], async () => assert.fail("no prompt"));
    assert.equal(result.outcome, "done");
    assert.deepEqual(srv.calls.map(({ route }) => route), ["status", "move_in"]);
    assert.equal(srv.calls[1].body.grant, undefined);
});

test("a wrong PIN asks again; a lockout says how long; cancelling moves nothing", async () => {
    let tries = 0;
    const srv = server({ unlock: () => {
        tries += 1;
        if (tries === 1) { throw failure(401, "incorrect PIN"); }
        if (tries === 2) { throw failure(429, "too many incorrect attempts - try again in 30s", { retry_after: 30 }); }
        return { grant: "g-2" };
    } });
    const prompts = [];
    const result = await run(srv, ["a"], async (asked) => { prompts.push(asked); return "1111"; });
    assert.equal(result.outcome, "done");
    assert.deepEqual(prompts.map(({ error, wait }) => [error, wait]), [
        [null, 0], ["Incorrect PIN.", 0], ["too many incorrect attempts - try again in 30s", 30]]);

    const cancelled = server();
    assert.equal((await run(cancelled, ["a"], async () => null)).outcome, "cancelled");
    assert.deepEqual(cancelled.calls.map(({ route }) => route), ["status"]);
});

test("not set up, or the server refusing, is reported and moves nothing", async () => {
    const unset = server({ status: { configured: true, pin_set: false } });
    assert.equal((await run(unset, ["a"], async () => "x")).outcome, "setup");
    assert.deepEqual(unset.calls.map(({ route }) => route), ["status"]);

    const refused = server({ unlock: () => { throw failure(400, "some of these items can't be moved"); } });
    const result = await run(refused, ["a"], async () => "2468");
    assert.deepEqual([result.outcome, result.text], ["failed", "some of these items can't be moved"]);
    assert.ok(!refused.calls.some(({ route }) => route === "move_in"));
});

test("a partial move is reported as partial, never as done", async () => {
    const srv = server({ move: () => ({ moved: [{ id: "a" }], failed: [{ id: "b", reason: "it is no longer in the library" }] }) });
    const result = await run(srv, ["a", "b"], async () => "2468");
    assert.equal(result.outcome, "partial");
    assert.equal(result.text, "Moved 1 of 2; 1 item couldn't be: it is no longer in the library.");

    const none = server({ move: () => ({ moved: [], failed: [{ id: "a", reason: "the disk is full" }] }) });
    assert.deepEqual(await run(none, ["a"], async () => "2468").then(({ outcome, text }) => [outcome, text]),
        ["failed", "Nothing was moved: the disk is full."]);
});
