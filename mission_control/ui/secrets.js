// Secrets a protected document's action asks for, and a secret its answer reveals (UI contract
// 1.2, docs/ui-contract.md "Protected documents"). The document only names them - `secrets`
// ({key: {kind, new?}}) and `reveal` (a field of the answer) - and Mission Control asks and shows
// them in dialogs of its own, whose words name the Satellite asking. A secret is typed only in
// those dialogs and goes only into the one request's body: never into a form's values, page state,
// storage, a notice or a log. A revealed value is shown once and dropped from the answer
// before anything else (a notice, `then`) sees it. The orchestration here is pure, so
// mission_control/tests/secrets.test.mjs can check it; the dialogs are checked in the browser.

import { SECRET_KINDS } from "./contract.js";
import { icon } from "./icons.js";

// what each kind is called in a dialog; a new PIN is asked twice
const WORDS = {
    pin: { name: "PIN", enter: "Enter your PIN", choose: "Choose a new PIN", again: "Enter the new PIN again" },
    "recovery-key": { name: "recovery key", enter: "Enter your recovery key" },
};

/** The prompts an action's `secrets` need, in order: [{key, kind, isNew}], or null when one of
 * them is something this client never asks for (an unknown kind, a malformed entry). */
export function secretPrompts(secrets) {
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
        return null;
    }
    const prompts = [];
    for (const [key, secret] of Object.entries(secrets)) {
        if (!secret || typeof secret !== "object" || !SECRET_KINDS.has(secret.kind)) {
            return null;
        }
        prompts.push({ key, kind: secret.kind, isNew: secret.new === true && secret.kind === "pin" });
    }
    return prompts.length ? prompts : null;
}

/** Asks for every secret through `ask({kind, isNew, again, error})`, which resolves what was
 * typed or null when cancelled. A new PIN is asked twice, and again from the start while the two
 * differ. Resolves {key: value} for the request body, or null once anything is cancelled. */
export async function askSecrets(secrets, ask) {
    const prompts = secretPrompts(secrets);
    if (!prompts) {
        return null;
    }
    const values = {};
    for (const { key, kind, isNew } of prompts) {
        let error = null;
        for (;;) {
            const first = await ask({ kind, isNew, again: false, error });
            if (first === null || first === undefined || first === "") {
                return null;
            }
            if (!isNew) {
                values[key] = first;
                break;
            }
            const second = await ask({ kind, isNew, again: true, error: null });
            if (second === null || second === undefined || second === "") {
                return null;
            }
            if (second === first) {
                values[key] = first;
                break;
            }
            error = "The two PINs don't match. Try again.";
        }
    }
    return values;
}

/** The request body with the secrets in it: the action's own body (an object) or nothing, and
 * each secret under its key. */
export function bodyWithSecrets(body, values) {
    const base = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    return { ...base, ...values };
}

/** Splits an answer: the revealed field's value (a non-empty string, else null) and the answer
 * without it, which is all that a notice or `then` may see. */
export function takeRevealed(result, field) {
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof field !== "string") {
        return { secret: null, rest: result };
    }
    const { [field]: secret, ...rest } = result;
    return { secret: typeof secret === "string" && secret ? secret : null, rest };
}

/** Shows the revealed field of an answer through `show(secret)` (resolves once the person said
 * it is stored), then resolves the answer without it. */
export async function revealFrom(result, field, show) {
    const { secret, rest } = takeRevealed(result, field);
    if (secret !== null) {
        await show(secret);
    }
    return rest;
}

// ---------- the dialogs ----------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = String(text);
    }
    return node;
}

function overlayFor(label) {
    const overlay = el("div", "ui-unlock");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", label);
    return overlay;
}

/** Mission Control's prompt for one secret: resolves what was typed, or null when cancelled.
 * `satellite` names who asks. The value lives only in the field, which is emptied as it closes. */
export function promptSecret({ kind, isNew = false, again = false, error = null, satellite = "" }) {
    const words = WORDS[kind] || WORDS.pin;
    const title = isNew ? (again ? words.again : words.choose) : words.enter;
    return new Promise((resolve) => {
        const returnFocus = document.activeElement;
        const overlay = overlayFor(title);
        const form = el("form", "ui-unlock-sheet");
        form.autocomplete = "off";
        const head = el("div", "ui-unlock-head");
        head.appendChild(icon("lock", 20) || el("span", null, ""));
        head.appendChild(el("p", "ui-unlock-title", title));
        form.appendChild(head);
        const who = satellite || "This interface";
        form.appendChild(el("p", "ui-text ui-text-caption", isNew
            ? `${who} asks for a new ${words.name}: 4 to 12 digits.`
            : `${who} asks for your ${words.name} to do this.`));
        const input = el("input", kind === "pin" ? "ui-input ui-unlock-pin" : "ui-input ui-secret-key");
        input.type = kind === "pin" ? "password" : "text";
        if (kind === "pin") {
            input.inputMode = "numeric";
            input.maxLength = 12;
        } else {
            input.spellcheck = false;
            input.autocapitalize = "characters";
        }
        input.autocomplete = "off";
        input.setAttribute("aria-label", words.name);
        input.required = true;
        form.appendChild(input);
        const message = el("p", "ui-unlock-error", error || "");
        message.setAttribute("role", "alert");
        message.hidden = !error;
        form.appendChild(message);
        const foot = el("div", "ui-unlock-foot");
        const cancel = el("button", "ui-pill", "Cancel");
        cancel.type = "button";
        const submit = el("button", "ui-pill ui-pill-primary", isNew && !again ? "Next" : "Continue");
        submit.type = "submit";
        foot.append(cancel, submit);
        form.appendChild(foot);
        overlay.appendChild(form);
        document.body.appendChild(overlay);

        const finish = (value) => {
            input.value = "";
            overlay.remove();
            if (returnFocus && typeof returnFocus.focus === "function") {
                returnFocus.focus();
            }
            resolve(value);
        };
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const value = kind === "pin" ? input.value : input.value.trim();
            if (value) {
                finish(value);
            }
        });
        cancel.addEventListener("click", () => finish(null));
        overlay.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                finish(null);
            }
        });
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                finish(null);
            }
        });
        input.focus();
    });
}

/** Shows a revealed secret once, until the person confirms they stored it. Nothing outside the
 * dialog holds it, and the dialog empties itself as it closes. */
export function showRevealed({ value, satellite = "" }) {
    return new Promise((resolve) => {
        const overlay = overlayFor("Store this somewhere safe");
        const sheet = el("div", "ui-unlock-sheet");
        const head = el("div", "ui-unlock-head");
        head.appendChild(icon("lock", 20) || el("span", null, ""));
        head.appendChild(el("p", "ui-unlock-title", "Store this somewhere safe"));
        sheet.appendChild(head);
        sheet.appendChild(el("p", "ui-text ui-text-caption",
            `${satellite || "This interface"} shows it this once and never again. Anyone who has it can reset your PIN.`));
        const code = el("code", "ui-secret-reveal", value);
        sheet.appendChild(code);
        const copy = el("button", "ui-pill", "Copy");
        copy.type = "button";
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(code.textContent);
                copy.textContent = "Copied";
            } catch (failure) {
                copy.textContent = "Select and copy it instead";
            }
        });
        const saved = el("label", "ui-toggle");
        const box = el("input", "sc-switch");
        box.type = "checkbox";
        box.setAttribute("role", "switch");
        saved.append(el("span", "ui-field-label", "I've stored it somewhere safe"), box);
        const foot = el("div", "ui-unlock-foot");
        const done = el("button", "ui-pill ui-pill-primary", "Done");
        done.type = "button";
        done.disabled = true;
        box.addEventListener("change", () => {
            done.disabled = !box.checked;
        });
        foot.append(copy, done);
        sheet.append(saved, foot);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
        done.addEventListener("click", () => {
            code.textContent = "";
            overlay.remove();
            resolve();
        });
        // never dismissed by a stray click or Escape: only once it is stored
        overlay.addEventListener("keydown", (event) => event.stopPropagation());
        copy.focus();
    });
}
