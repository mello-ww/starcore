// Moving photos into the Locked Folder from Photo's own page, asking for the PIN first when
// this session hasn't unlocked it. The vault is locked again after every attempt that got as
// far as the move - success or failure - because the unlock was only for the move. If that
// lock can't be sent, the person is told when the server will lock it by itself, the lock is
// tried again when the connection comes back and when the page goes away, and the outcome is
// never reported as a plain success. See docs/satellites/locked_folder.md.

/**
 * @param api the Locked Folder's routes: {get(path), post(path, body), url(path)}
 * @param photoIds the photos to move
 * @param requestUnlock shows the Locked Folder's PIN prompt; resolves true once unlocked
 * @returns {outcome: "setup" | "cancelled" | "moved" | "failed", error?, locked?, locksAt?}
 */
export async function moveIntoLockedFolder(api, photoIds, { requestUnlock, now = Date.now }) {
    const state = await api.get("/status");
    if (!state.configured || !state.pin_set) {
        return { outcome: "setup" };
    }
    if (!state.unlocked && !(await requestUnlock())) {
        return { outcome: "cancelled" };
    }
    let error = null;
    try {
        const result = await api.post("/move_in", { photo_ids: photoIds });
        if (result && Array.isArray(result.failed) && result.failed.length) {
            error = new Error(result.failed[0].reason || "the photo could not be moved");
        }
    } catch (failure) {
        error = failure;
    }
    const lock = await lockAgain(api, state, now);
    return { outcome: error ? "failed" : "moved", error, ...lock };
}

/** Locks the vault again: {locked: true}, or {locked: false, locksAt} with when the server's
 * own time limit ends the unlock if the request didn't go through. */
export async function lockAgain(api, state, now = Date.now) {
    try {
        await api.post("/lock", {});
        return { locked: true };
    } catch {
        const known = state && state.unlocked && state.expires_at ? new Date(state.expires_at).getTime() : NaN;
        const timeout = Number(state && state.session_timeout_seconds) || 900;
        // a fresh unlock (from the prompt) lasts the session timeout from about now
        const locksAt = Number.isFinite(known) ? known : now() + timeout * 1000;
        return { locked: false, locksAt: new Date(locksAt) };
    }
}

/** Tries the lock once more when the browser is back online, and as the page goes away. */
export function retryLockLater(api, target = globalThis) {
    let done = false;
    const attempt = () => {
        if (done) {
            return;
        }
        done = true;
        target.removeEventListener("online", attempt);
        target.removeEventListener("pagehide", onPageHide);
        api.post("/lock", {}).catch(() => {});
    };
    const onPageHide = () => {
        if (done) {
            return;
        }
        done = true;
        target.removeEventListener("online", attempt);
        target.removeEventListener("pagehide", onPageHide);
        const beacon = target.navigator && target.navigator.sendBeacon;
        if (beacon) {
            beacon.call(target.navigator, api.url("/lock"));
        }
    };
    target.addEventListener("online", attempt);
    target.addEventListener("pagehide", onPageHide);
    return attempt;
}

const clock = (at) => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The notice for an outcome: {text, isError}, or null when there is nothing to say. */
export function moveNotice(result, formatTime = clock) {
    if (result.outcome === "setup" || result.outcome === "cancelled") {
        return null;
    }
    const stillOpen = result.locked === false
        ? ` The Locked Folder couldn't be locked again: it locks by itself at ${formatTime(result.locksAt)}.`
        : "";
    if (result.outcome === "moved") {
        return { text: `Moved to the Locked Folder.${stillOpen}`, isError: Boolean(stillOpen) };
    }
    const reason = (result.error && result.error.message) || "please try again";
    return { text: `The photo could not be moved: ${reason}.${stillOpen}`, isError: true };
}
