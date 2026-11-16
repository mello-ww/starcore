// Protected documents (UI contract 1.2), Mission Control's side: a document that declares
// `protected: {capability, setup, forgot?}` belongs to a store its own Satellite keeps locked, and
// this gate decides what of it may show.
//
// - Before any page it asks the provider's status: not set up, the document's setup page;
//   locked, Mission Control's own PIN prompt, for a full unlock of this session; open, the page.
// - The prompt's "Forgot your PIN?" (when the document names a forgot page) shows that page
//   instead: nothing of the store, nothing unlocked. Its way back, or its action, asks again.
// - A 403 from the document's routes asks status again: locked again means the prompt, never an
//   error page with the store's content still behind it.
// - While the document shows, `keep` tells the server it is still in use, so the unlock outlives
//   the server's idle time - and only then: a tab that dies leaves it open that long at most.
// - It locks when the document closes, when the page goes away, and when the tab stays hidden
//   for LEAVE_GRACE_SECONDS (long enough to open a file in another tab).
// - The PIN is held only while its request is sent: never stored, logged, or kept in page state.
// No DOM here beyond what the caller passes in, so contracts/ui/tests can run it.
// See docs/ui-contract.md ("protected").

import { CAPABILITY_VERSIONS, PROTECTED_CAPABILITIES } from "./contract.js";

/** How often a shown document calls keep; well inside the server's idle time. */
export const KEEP_SECONDS = 30;
/** How long a hidden tab keeps the unlock before it locks. */
export const LEAVE_GRACE_SECONDS = 10;

/** The provider of a protected document's store - its own Satellite's, offering every
 * operation the gate calls - or null when this client can't open it. */
export function protectedProvider(document, capabilities, satellite) {
    const capability = document && document.protected && document.protected.capability;
    const required = Object.hasOwn(PROTECTED_CAPABILITIES, String(capability)) ? PROTECTED_CAPABILITIES[capability] : null;
    if (!required) {
        return null;
    }
    const versions = CAPABILITY_VERSIONS[capability] || [];
    const provider = ((capabilities && capabilities[capability]) || [])
        .find((entry) => entry && entry.satellite === satellite && versions.includes(entry.version));
    const operations = (provider && provider.operations) || {};
    return provider && required.every((name) => typeof operations[name] === "string") ? provider : null;
}

/** What a status answer means for the document: "setup", "locked", "open" or "failed" (the
 * gate's own "checking" and "forgot" are never a status answer). */
export function gateState(status) {
    if (!status || typeof status !== "object" || Array.isArray(status)) {
        return "failed";
    }
    if (!status.configured || !status.pin_set || status.pin_unreadable || (status.security && status.security.problem)) {
        return "setup";
    }
    return status.unlocked === true ? "open" : "locked";
}

/**
 * The gate of one mounted protected document.
 * - `request(route, body?)` calls the provider (GET without a body) and throws an error with
 *   `status` (and `payload`) when it refuses;
 * - `prompt({purpose: "unlock", error, wait, signal})` resolves the PIN, or null for cancel;
 * - `lock(route)` sends the lock even as the page goes away (a keepalive request);
 * - `onChange(state, detail)` hears every change of "checking", "setup", "locked", "forgot",
 *   "open" and "failed" (detail: the reason).
 * Returns {state(), check({quiet}), unlock(), forgot(), setHidden(hidden), leave(), dispose()}.
 */
export function createVaultGate({ provider, request, prompt, lock, onChange, timers = globalThis,
    keepSeconds = KEEP_SECONDS, graceSeconds = LEAVE_GRACE_SECONDS }) {
    const operations = provider.operations;
    let current = null;
    let detail = null;
    let run = 0;           // each check or leave starts a new run: an older answer is dropped
    let keeper = null;
    let grace = null;
    let asking = null;     // the open prompt's AbortController
    let hidden = false;
    let left = false;
    let disposed = false;

    function set(next, why = null) {
        if (disposed || (next === current && why === detail)) {
            return;
        }
        current = next;
        detail = why;
        onChange(next, why);
    }

    function stopKeeping() {
        timers.clearInterval(keeper);
        keeper = null;
    }

    function startKeeping() {
        stopKeeping();
        keeper = timers.setInterval(async () => {
            if (hidden || current !== "open") {
                return;
            }
            try {
                await request(operations.keep, {});
            } catch (error) {
                if (error && (error.status === 401 || error.status === 403)) {
                    check({ quiet: true });
                }
                // anything else (StarCore not answering) is for the page's own notice
            }
        }, keepSeconds * 1000);
    }

    function closePrompt() {
        if (asking) {
            asking.abort();
            asking = null;
        }
    }

    function opened() {
        set("open");
        startKeeping();
    }

    /** Asks status and shows what it says. `quiet` keeps what shows until the answer (after a
     * 403, or keep's refusal): content fetched while open stays until the server says locked. */
    async function check({ quiet = false } = {}) {
        if (disposed) {
            return;
        }
        const mine = ++run;
        left = false;
        closePrompt();
        if (!quiet) {
            stopKeeping();
            set("checking");
        }
        let status;
        try {
            status = await request(operations.status);
        } catch (error) {
            if (mine === run) {
                stopKeeping();
                set("failed", (error && error.message) || "StarCore did not answer.");
            }
            return;
        }
        if (mine !== run) {
            return;
        }
        const next = gateState(status);
        if (next === "open") {
            if (current !== "open" || !keeper) {
                opened();
            }
        } else if (next === "locked") {
            await ask(mine);
        } else {
            stopKeeping();
            set(next, next === "failed" ? "StarCore's answer couldn't be read." : null);
        }
    }

    /** The prompt, until the PIN opens the store, the person cancels, or a newer run starts. */
    async function ask(mine) {
        stopKeeping();
        set("locked");  // nothing of the store shows behind the prompt
        let error = null;
        let wait = 0;
        for (;;) {
            closePrompt();
            asking = new AbortController();
            const pin = await prompt({ purpose: "unlock", error, wait, signal: asking.signal });
            if (mine !== run) {
                return;
            }
            asking = null;
            if (pin === null || pin === undefined) {
                return;  // stays locked: the page offers to unlock again
            }
            try {
                const result = await request(operations.unlock, { pin });
                if (mine !== run) {
                    return;
                }
                if (result && result.unlocked === true) {
                    opened();
                } else {
                    set("failed", "The unlock didn't open it.");
                }
                return;
            } catch (failure) {
                if (mine !== run) {
                    return;
                }
                if (failure && failure.status === 401) {
                    error = "Incorrect PIN.";
                    wait = 0;
                } else if (failure && failure.status === 429) {
                    error = failure.message;
                    wait = Number(failure.payload && failure.payload.retry_after) || 0;
                } else {
                    set("failed", (failure && failure.message) || "StarCore did not answer.");
                    return;
                }
            }
        }
    }

    /** "Forgot your PIN?", from the prompt or the locked card: the forgot page instead, while
     * locked. A newer run drops the prompt's answer; check() leads back. */
    function forgot() {
        if (disposed || current !== "locked") {
            return;
        }
        run += 1;
        closePrompt();
        stopKeeping();
        set("forgot");
    }

    /** Locks now: the document closed, the page went away, or the tab stayed hidden. */
    function leave() {
        if (disposed) {
            return;
        }
        run += 1;
        left = true;
        timers.clearTimeout(grace);
        grace = null;
        closePrompt();
        stopKeeping();
        if (current !== "setup" && current !== "forgot") {
            try {
                lock(operations.lock);
            } catch {
                // best effort: the server's idle time ends it anyway
            }
        }
        set("locked");
    }

    function setHidden(value) {
        hidden = Boolean(value);
        timers.clearTimeout(grace);
        grace = null;
        if (hidden) {
            if (current === "open" || current === "locked" || current === "checking") {
                grace = timers.setTimeout(leave, graceSeconds * 1000);
            }
        } else if (left) {
            check();
        }
    }

    return {
        state: () => current,
        check,
        unlock: () => {
            left = false;
            return ask(++run);
        },
        forgot,
        setHidden,
        leave,
        dispose() {
            leave();
            disposed = true;
        },
    };
}
