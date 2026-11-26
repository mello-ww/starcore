// Mission Control's shared motion, the same as the Android app's (mobile/src/components/motion.tsx):
// an accent that slides between the options of a row (a document's tabs or sidebar, a choice's
// segments) instead of jumping. A page is drawn again on every change, so each row names itself
// with a key and the accent starts where that row last had it. Reduced motion places it at once
// (the stylesheet drops its transition).

/** How long the accent takes to move, as `--sc-motion-move` says in ui.css. */
export const MOVE_MS = 220;

/** Each remembered row's last move, by the row's key: from where, to where, and when it began. */
const places = new Map();

/** The box an option takes within its row: what the accent covers. */
export function placeOf(node) {
    return { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight };
}

/** Whether the accent moves from `from` to `to`, rather than appearing there. */
export function slides(from, to) {
    return Boolean(from && to) && (from.x !== to.x || from.y !== to.y || from.width !== to.width);
}

/**
 * Where a move begun `elapsed` ms ago has got to (its easing is close to an ease-out cubic), and
 * how long it still has to run: a row drawn again while its accent moves carries on from there.
 */
export function inFlight(move, elapsed) {
    if (!move || elapsed >= MOVE_MS || !slides(move.from, move.to)) {
        return null;
    }
    const t = Math.max(0, elapsed) / MOVE_MS;
    const eased = 1 - (1 - t) ** 3;
    const at = {};
    for (const key of ["x", "y", "width", "height"]) {
        at[key] = move.from[key] + (move.to[key] - move.from[key]) * eased;
    }
    return { at, remaining: MOVE_MS - Math.max(0, elapsed) };
}

function sameTarget(a, b) {
    return a.x === b.x && a.y === b.y;
}

/** Forget every remembered row (tests). */
export function forgetPlaces() {
    places.clear();
}

/**
 * Put the row's sliding accent behind `active` (an option of `row`, or null for none), starting
 * from where the row named `key` last had it. The row draws its options' accent through it: the
 * active option itself paints none once the accent is there.
 */
export function slideSelection(row, active, key) {
    let accent = row.querySelector(":scope > .ui-slide");
    if (!active) {
        accent?.remove();
        places.delete(key);
        return;
    }
    if (!accent) {
        accent = document.createElement("span");
        accent.className = "ui-slide";
        accent.setAttribute("aria-hidden", "true");
        row.prepend(accent);
    }
    row.classList.add("ui-slide-row");
    const to = placeOf(active);
    const now = performance.now();
    const last = places.get(key);
    // the row drawn again while its accent was still moving carries on; otherwise it moves from
    // where it came to rest
    const flying = last ? inFlight(last, now - last.start) : null;
    const from = flying ? flying.at : last?.to;
    const put = (place) => {
        accent.style.transform = `translate(${place.x}px, ${place.y}px)`;
        accent.style.width = `${place.width}px`;
        accent.style.height = `${place.height}px`;
    };
    if (slides(from, to)) {
        accent.classList.add("ui-slide-still");
        put(from);
        accent.getBoundingClientRect();  // the old place is drawn first, so the move shows
        accent.classList.remove("ui-slide-still");
        // carrying on towards the same option keeps that move's clock; a new option starts a move
        const same = flying && sameTarget(last.to, to);
        accent.style.transitionDuration = same ? `${Math.round(flying.remaining)}ms` : "";
        places.set(key, same ? { from: last.from, to, start: last.start } : { from, to, start: now });
        put(to);
    } else {
        // a row drawn again with the same option (another part of the page changed) keeps its
        // accent in place: a new accent would otherwise grow from the row's corner
        places.set(key, { from: to, to, start: now });
        accent.classList.add("ui-slide-still");
        put(to);
        accent.getBoundingClientRect();
        accent.classList.remove("ui-slide-still");
    }
    active.classList.add("ui-slid");
    follow(row, accent, active, key);
}

/** Rows whose options change place without being drawn again (a narrower window), and what to follow. */
const followed = new WeakMap();
let resizes = null;

// a row laid out anew (the window resized, a sidebar folded to icons) puts its accent at once
// where its active option now is
function follow(row, accent, active, key) {
    if (typeof ResizeObserver === "undefined") {
        return;
    }
    resizes ??= new ResizeObserver((entries) => {
        for (const { target } of entries) {
            const watched = followed.get(target);
            if (!watched || !watched.active.isConnected) {
                continue;
            }
            const to = placeOf(watched.active);
            const at = places.get(watched.key);
            if (at && !slides(at.to, to)) {
                continue;
            }
            watched.accent.classList.add("ui-slide-still");
            watched.accent.style.transform = `translate(${to.x}px, ${to.y}px)`;
            watched.accent.style.width = `${to.width}px`;
            watched.accent.style.height = `${to.height}px`;
            watched.accent.getBoundingClientRect();
            watched.accent.classList.remove("ui-slide-still");
            places.set(watched.key, { from: to, to, start: performance.now() });
        }
    });
    if (!followed.has(row)) {
        resizes.observe(row);
    }
    followed.set(row, { accent, active, key });
}
