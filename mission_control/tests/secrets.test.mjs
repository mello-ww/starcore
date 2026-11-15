// Secrets and reveal (UI contract 1.2), Mission Control's side: a protected document's action
// names what to ask, Mission Control asks in its own prompt - twice for a new PIN - and the values
// go only into the one request's body; a revealed field is shown once and gone from the answer
// before a notice or `then` sees it. The dialogs themselves are checked in the browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkDocument, knownSecrets } from "../ui/contract.js";
import { formBody, formValues } from "../ui/forms.js";
import { askSecrets, bodyWithSecrets, revealFrom, secretPrompts, takeRevealed } from "../ui/secrets.js";

function typing(...answers) {
    const asked = [];
    return {
        asked,
        ask: async (prompt) => {
            asked.push(prompt);
            return answers.shift() ?? null;
        },
    };
}

test("the prompts follow the document's order, and only known kinds are asked", () => {
    assert.deepEqual(secretPrompts({ current_pin: { kind: "pin" }, pin: { kind: "pin", new: true } }), [
        { key: "current_pin", kind: "pin", isNew: false },
        { key: "pin", kind: "pin", isNew: true },
    ]);
    assert.deepEqual(secretPrompts({ recovery_key: { kind: "recovery-key", new: true } }),
        [{ key: "recovery_key", kind: "recovery-key", isNew: false }], "only a PIN is chosen anew");
    assert.equal(secretPrompts({ password: { kind: "password" } }), null);
    assert.equal(secretPrompts({}), null);
    assert.equal(secretPrompts(null), null);
    assert.equal(knownSecrets({ pin: { kind: "pin" } }), true);
    assert.equal(knownSecrets({ pin: { kind: "password" } }), false);
});

test("a new PIN is asked twice, and from the start again while the two differ", async () => {
    const user = typing("1111", "4321", "1234", "9999", "9999");
    const values = await askSecrets({ current_pin: { kind: "pin" }, pin: { kind: "pin", new: true } }, user.ask);
    assert.deepEqual(values, { current_pin: "1111", pin: "9999" });
    assert.deepEqual(user.asked.map(({ isNew, again, error }) => [isNew, again, Boolean(error)]), [
        [false, false, false],
        [true, false, false], [true, true, false],
        [true, false, true], [true, true, false],
    ]);
});

test("cancelling any prompt sends nothing", async () => {
    assert.equal(await askSecrets({ pin: { kind: "pin" } }, typing(null).ask), null);
    assert.equal(await askSecrets({ pin: { kind: "pin", new: true } }, typing("1234", null).ask), null);
    assert.equal(await askSecrets({ a: { kind: "pin" }, b: { kind: "recovery-key" } }, typing("1234", "").ask), null);
    const never = typing("1234");
    assert.equal(await askSecrets({ x: { kind: "password" } }, never.ask), null);
    assert.equal(never.asked.length, 0, "an unknown kind is never asked");
});

test("the secrets go only into the request's body, never into the form's values", async () => {
    const fields = [{ key: "run", label: "Run", kind: "text", value: "$.run" }];
    const values = formValues(fields, { data: { run: "r1" } });
    const form = formBody(values);
    const secrets = await askSecrets({ pin: { kind: "pin" } }, typing("2468").ask);
    const body = bodyWithSecrets(form, secrets);
    assert.deepEqual(body, { run: "r1", pin: "2468" });
    assert.deepEqual(values, { run: "r1" }, "the form's own values hold no secret");
    assert.deepEqual(form, { run: "r1" });
    assert.deepEqual(bodyWithSecrets(["not", "an", "object"], { pin: "1" }), { pin: "1" });
});

test("a revealed field is shown once and gone from the answer", async () => {
    const shown = [];
    const answer = { started: true, recovery_key: "ABCD-EFGH", message: "Encrypting." };
    const rest = await revealFrom(answer, "recovery_key", async (secret) => shown.push(secret));
    assert.deepEqual(shown, ["ABCD-EFGH"]);
    assert.deepEqual(rest, { started: true, message: "Encrypting." });
    assert.equal(JSON.stringify(rest).includes("ABCD"), false);
    // nothing to show: no dialog, the answer unchanged but for the field
    assert.deepEqual(takeRevealed({ started: true, recovery_key: null }, "recovery_key"), { secret: null, rest: { started: true } });
    const none = [];
    await revealFrom({ ok: true }, "recovery_key", async (secret) => none.push(secret));
    assert.deepEqual(none, []);
});

test("Mission Control refuses secrets outside a protected document, and kinds it doesn't know", () => {
    const button = (action) => ({ type: "button", label: "Go", action });
    const plain = (action) => ({ contract: "starcore.ui/1.2", entry: "home", pages: { home: { blocks: [button(action)] } } });
    assert.match(checkDocument(plain({ route: "pin", secrets: { pin: { kind: "pin" } } })), /isn't protected/);
    assert.match(checkDocument(plain({ route: "key", reveal: "recovery_key" })), /isn't protected/);
    const guarded = { ...plain({ route: "pin", secrets: { pin: { kind: "pin" } } }), protected: { capability: "media.vault", setup: "home" } };
    assert.equal(checkDocument(guarded), null);
    guarded.pages.home.blocks[0].action.secrets = { pin: { kind: "password" } };
    assert.match(checkDocument(guarded), /doesn't know/);
});

test("nothing that handles a secret logs it or keeps it in storage", () => {
    for (const name of ["secrets.js", "forms.js"]) {
        const source = readFileSync(new URL(`../ui/${name}`, import.meta.url), "utf-8");
        assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|indexedDB/, name);
    }
    const renderer = readFileSync(new URL("../ui/renderer.js", import.meta.url), "utf-8");
    const asking = renderer.slice(renderer.indexOf("if (action.secrets !== undefined)"), renderer.indexOf("body = null;"));
    assert.ok(asking.length > 0);
    assert.doesNotMatch(asking, /console\.|localStorage|sessionStorage|state\.forms|setNotice\([^"`)]*secrets/);
});

test("after any action it ran, a protected document asks its store's status again", () => {
    const renderer = readFileSync(new URL("../ui/renderer.js", import.meta.url), "utf-8");
    const done = renderer.slice(renderer.indexOf("body = null;"), renderer.indexOf("const then = action.then;"));
    // a new PIN ends every unlock, a delink goes back to setup: never only while in setup
    assert.match(done, /if \(gate\) \{[^}]*gate\.check\(\{ quiet: true \}\);/);
    assert.doesNotMatch(done, /gate\.state\(\) === "setup"/);
});
