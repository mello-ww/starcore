// A row's own actions (UI contract 1.2): a media-list row's or a media-grid tile's `quick`
// buttons and `menu`, the answer an action merges into its row (`then: "update"`), and what a
// page keeps per history entry so going back finds it as it was. Pure, no DOM, so
// mission_control/tests/rows.test.mjs can check it; the renderer and the gallery draw.
import { isVisible, resolve } from "./contract.js";

function shown(entry, scope, canRun) {
    return Boolean(entry && entry.action)
        && (entry.visible === undefined || isVisible(resolve(entry.visible, scope)))
        && (!canRun || canRun(entry.action));
}

/** A row's quick buttons: every entry whose `visible` holds and that this client can run, so a
 * pair bound to opposite values (`$.liked`, `$.not_liked`) draws as one toggle. */
export function rowQuick(block, scope, canRun) {
    return (Array.isArray(block.quick) ? block.quick : []).filter((entry) => shown(entry, scope, canRun));
}

/** A row's menu: the entries whose `visible` holds and that this client can run - a menu
 * leaves out what can't be done here rather than offering it and failing. Empty: no menu. */
export function rowMenu(block, scope, canRun) {
    return (Array.isArray(block.menu) ? block.menu : []).filter((entry) => shown(entry, scope, canRun));
}

/** `then: "update"`: the answer's `item` (an object) merged into the row, in place, so the row
 * keeps its key and its place in the list. True when something was merged. */
export function mergeItem(row, answer) {
    const item = answer && typeof answer === "object" ? answer.item : null;
    if (!row || typeof row !== "object" || !item || typeof item !== "object" || Array.isArray(item)) {
        return false;
    }
    Object.assign(row, item);
    return true;
}

/** The group a row starts (`item.group`), as text; "" for none. */
export function groupOf(block, scope, format = (value) => String(value)) {
    if (!block.item || block.item.group === undefined) {
        return "";
    }
    const raw = resolve(block.item.group, scope);
    return raw === null || raw === undefined || raw === "" ? "" : format(raw);
}

/** Whether a row is the track playing now: its `item.audio` binding against the host's current
 * track id (null when nothing plays, or it plays from another Satellite). */
export function isPlayingRow(block, scope, playing) {
    if (!playing || !block.item || block.item.audio === undefined) {
        return false;
    }
    const id = resolve(block.item.audio, scope);
    return id !== null && id !== undefined && String(id) === String(playing);
}

/** What each history entry of an interface left behind - its page data, the pages its lists
 * loaded and how far it was scrolled - so Back draws it again as it was. The newest `limit`
 * entries are kept. */
export function createEntries(limit = 20) {
    const entries = new Map();
    return {
        save(id, kept) {
            entries.delete(id);
            entries.set(id, kept);
            while (entries.size > limit) {
                entries.delete(entries.keys().next().value);
            }
        },
        get(id) {
            return entries.get(id) || null;
        },
        scroll(id, top) {
            const kept = entries.get(id);
            if (kept) {
                kept.scroll = top;
            }
        },
        clear() {
            entries.clear();
        },
    };
}
