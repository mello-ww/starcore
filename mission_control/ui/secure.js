// The secure action (UI contract 1.2), Mission Control's side: one protected operation - so far
// media.vault's move_in - on the items a media viewer shows or a selection holds, behind
// Mission Control's own unlock prompt.
//
// - The document names only the operation and how to bind each item's id. The provider comes
//   from the catalog, the references are built for the document Satellite's own media.gallery
//   items, and the prompt, its words and the PIN field belong to Mission Control.
// - When the session hasn't unlocked the provider, the PIN asks it for a single-use grant for
//   exactly these items, not an unlock: nothing opens, so nothing has to be locked again, and a
//   tab closed half way leaves at most a grant that expires by itself.
// - The PIN is held only while its request is sent: never stored, logged, or kept in page state.
// See docs/ui-contract.md ("secure") and docs/satellites/locked_folder.md.

import { findProvider } from "./contract.js";
import { icon } from "./icons.js";

/** What this client can run (the vocabulary's secure_operations; checked by the shared tests). */
export const SECURE_OPERATIONS = { "media.vault": ["move_in"] };
const GALLERY = "media.gallery";

/** The provider an action would run on, or null when this client can't run it here: an
 * operation it doesn't know, no enabled provider offering it, or a Satellite acting on items
 * it doesn't provide. A control for an action that can't run is hidden. */
export function secureProvider(action, capabilities, satellite) {
    const secure = action && action.secure;
    if (!secure || !(SECURE_OPERATIONS[secure.capability] || []).includes(secure.operation)) {
        return null;
    }
    const gallery = findProvider(capabilities, GALLERY);
    if (!gallery || gallery.satellite !== satellite) {
        return null;
    }
    const provider = findProvider(capabilities, secure.capability);
    const operations = (provider && provider.operations) || {};
    return provider && ["status", "unlock", secure.operation].every((name) => typeof operations[name] === "string")
        ? provider : null;
}

/** References to the document Satellite's own gallery items: what the server resolves itself. */
export function references(satellite, ids) {
    const seen = new Set();
    const result = [];
    for (const id of ids) {
        const text = id === null || id === undefined ? "" : String(id);
        if (text && !seen.has(text)) {
            seen.add(text);
            result.push({ provider: satellite, capability: GALLERY, id: text });
        }
    }
    return result;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Runs the operation once on `ids`. `request(path, body?)` calls the provider (GET without a
 * body), `prompt({count, error, wait})` resolves the PIN or null for cancel. Resolves
 * {outcome: "done" | "partial" | "failed" | "cancelled" | "setup", text, moved, failed}.
 */
export async function runSecure({ action, ids, satellite, provider, request, prompt }) {
    const items = references(satellite, ids);
    if (!items.length) {
        return { outcome: "failed", text: "Nothing to move.", moved: [], failed: [] };
    }
    const operations = provider.operations;
    const operation = action.secure.operation;
    let status;
    try {
        status = await request(operations.status);
    } catch (error) {
        return { outcome: "failed", text: error.message, moved: [], failed: [] };
    }
    if (!status || !status.configured || !status.pin_set) {
        return { outcome: "setup", text: "This isn't set up yet: give it a location and a PIN in its own screens first.",
            moved: [], failed: [] };
    }

    const body = { items };
    if (!status.unlocked) {
        // a grant for exactly these items, with the PIN typed in this client's own prompt
        let error = null;
        let wait = 0;
        for (;;) {
            const pin = await prompt({ count: items.length, error, wait });
            if (pin === null || pin === undefined) {
                return { outcome: "cancelled", text: null, moved: [], failed: [] };
            }
            try {
                const granted = await request(operations.unlock, { pin, for: { operation, items } });
                if (!granted || typeof granted.grant !== "string") {
                    return { outcome: "failed", text: "The unlock didn't give a way to do this.", moved: [], failed: [] };
                }
                body.grant = granted.grant;
                break;
            } catch (failure) {
                if (failure.status === 401) {
                    error = "Incorrect PIN.";
                    wait = 0;
                } else if (failure.status === 429) {
                    error = failure.message;
                    wait = Number(failure.payload && failure.payload.retry_after) || 0;
                } else {
                    return { outcome: "failed", text: failure.message, moved: [], failed: [] };
                }
            }
        }
    }

    let result;
    try {
        result = await request(operations[operation], body);
    } catch (error) {
        return { outcome: "failed", text: error.message, moved: [], failed: [] };
    }
    const moved = Array.isArray(result && result.moved) ? result.moved : [];
    const failed = Array.isArray(result && result.failed) ? result.failed : [];
    if (!failed.length) {
        return { outcome: "done", text: `Moved ${plural(moved.length, "item")}.`, moved, failed };
    }
    const reason = failed[0] && failed[0].reason ? `: ${failed[0].reason}` : "";
    const text = moved.length
        ? `Moved ${moved.length} of ${items.length}; ${plural(failed.length, "item")} couldn't be${reason}.`
        : `Nothing was moved${reason}.`;
    return { outcome: moved.length ? "partial" : "failed", text, moved, failed };
}

// ---------- the prompt ----------

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

/** Mission Control's PIN prompt: resolves the PIN typed, or null when cancelled. Its words are
 * Mission Control's own; the PIN lives only in the field, which is emptied as it closes. */
export function promptPin({ count, error = null, wait = 0 }) {
    return new Promise((resolve) => {
        const returnFocus = document.activeElement;
        const overlay = el("div", "ui-unlock");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Enter your PIN");
        const form = el("form", "ui-unlock-sheet");
        form.autocomplete = "off";
        const head = el("div", "ui-unlock-head");
        head.appendChild(icon("lock", 20) || el("span", null, ""));
        head.appendChild(el("p", "ui-unlock-title", "Enter your PIN"));
        form.appendChild(head);
        form.appendChild(el("p", "ui-text ui-text-caption",
            `To move ${count === 1 ? "this item" : `these ${count} items`} into the protected folder. It stays locked.`));
        const input = el("input", "ui-input ui-unlock-pin");
        input.type = "password";
        input.inputMode = "numeric";
        input.autocomplete = "off";
        input.setAttribute("aria-label", "PIN");
        input.maxLength = 12;
        input.required = true;
        form.appendChild(input);
        const message = el("p", "ui-unlock-error", error || "");
        message.setAttribute("role", "alert");
        message.hidden = !error;
        form.appendChild(message);
        const foot = el("div", "ui-unlock-foot");
        const cancel = el("button", "ui-pill", "Cancel");
        cancel.type = "button";
        const submit = el("button", "ui-pill ui-pill-primary", "Unlock and move");
        submit.type = "submit";
        foot.append(cancel, submit);
        form.appendChild(foot);
        overlay.appendChild(form);
        document.body.appendChild(overlay);

        let timer = null;
        if (wait > 0) {
            // locked out: the button waits as long as the server said
            let left = Math.ceil(wait);
            submit.disabled = true;
            submit.textContent = `Try again in ${left}s`;
            timer = setInterval(() => {
                left -= 1;
                if (left <= 0) {
                    clearInterval(timer);
                    submit.disabled = false;
                    submit.textContent = "Unlock and move";
                } else {
                    submit.textContent = `Try again in ${left}s`;
                }
            }, 1000);
        }

        const finish = (value) => {
            clearInterval(timer);
            input.value = "";
            overlay.remove();
            if (returnFocus && typeof returnFocus.focus === "function") {
                returnFocus.focus();
            }
            resolve(value);
        };
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const pin = input.value;
            if (pin && !submit.disabled) {
                finish(pin);
            }
        });
        cancel.addEventListener("click", () => finish(null));
        overlay.addEventListener("keydown", (event) => {
            event.stopPropagation();  // never the viewer's arrows or Escape underneath
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
