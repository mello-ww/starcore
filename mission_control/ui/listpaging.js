// A list that arrives page by page (UI contract 1.2, `more` on a list): the page data holds the
// first page and the provider's cursor for the next; each further page comes from `more.route`
// with that cursor as $value, in the page data's own shape. The provider owns the cursor - this
// only passes it back. Pure state, no DOM, so mission_control/tests/listpaging.test.mjs can
// check it; the renderer draws the rows and the footer.
import { isSafeRoute, resolve, resolveTemplate } from "./contract.js";

/** What a cursor means: null at the end (none, empty, or the same cursor again, which would
 * only fetch the same page forever). */
function nextCursor(value, previous) {
    return value === null || value === undefined || value === "" || value === previous ? null : value;
}

/** A row's identity, to never show one twice when a provider's pages overlap: its `item.key`
 * binding (1.2) when the block has one, so a row updated in place (`then: "update"`) is still the
 * same row, else the whole row. */
export function rowKey(block, item, scope) {
    if (block && block.item && block.item.key !== undefined) {
        const key = resolve(block.item.key, { ...scope, data: item });
        return key === null || key === undefined || key === "" ? null : String(key);
    }
    try {
        return JSON.stringify(item);
    } catch {
        return null;
    }
}

/**
 * host: {load(route) -> Promise<data>} (a page from the Satellite's own route, with the session).
 * Returns {rows(block, scope), status(block), loadMore(block), reset(), snapshot(), restore()}.
 */
export function createListPaging(host) {
    let lists = new Map();

    function stateOf(block) {
        let list = lists.get(block);
        if (!list) {
            list = {
                base: null, collection: null, extra: [], keys: new Set(), cursor: null,
                scope: null, loading: null, error: null, token: 0, pages: 0, depth: 0, kept: false,
            };
            lists.set(block, list);
        }
        return list;
    }

    /** The page data changed (first load, a refresh, another folder): the list starts again
     * from it. A refresh of the same collection loads as many pages again as were loaded. */
    function adopt(block, list, base, scope) {
        const collection = resolveTemplate(block.more.route, { ...scope, value: "" });
        const same = collection === list.collection && list.base !== null;
        const keyOf = (item) => rowKey(block, item, scope);
        if (same && list.kept) {
            // back on a page whose rows were kept (restore): its first page is the fresh one, the
            // pages loaded after it stay where they are, so the place the person left is still there
            list.kept = false;
            list.base = base;
            list.keys = new Set(base.map(keyOf).filter((key) => key !== null));
            list.extra = list.extra.filter((item) => {
                const key = keyOf(item);
                if (key === null) {
                    return true;
                }
                if (list.keys.has(key)) {
                    return false;
                }
                list.keys.add(key);
                return true;
            });
            list.token += 1;
            list.loading = null;
            list.error = null;
            return;
        }
        list.kept = false;
        list.depth = same ? list.pages : 0;
        list.base = base;
        list.collection = collection;
        list.extra = [];
        list.keys = new Set(base.map(keyOf).filter((key) => key !== null));
        list.pages = 0;
        list.token += 1;  // any page still on its way belongs to the old data
        list.loading = null;
        list.error = null;
        list.cursor = nextCursor(resolve(block.more.cursor, scope), null);
    }

    /** Every row to draw now: the page data's own, then the pages loaded after them. */
    function rows(block, scope) {
        const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
        const base = Array.isArray(resolved) ? resolved : [];
        if (!block.more) {
            return base;
        }
        const list = stateOf(block);
        list.scope = scope;
        if (list.base !== base) {
            adopt(block, list, base, scope);
        }
        return list.base.concat(list.extra);
    }

    /** {more, loading, error, restoring}: whether there is a next page, one is on its way, the
     * last one failed, or a refresh is still loading back the pages it had. */
    function status(block) {
        const list = stateOf(block);
        return {
            more: Boolean(list.cursor),
            loading: Boolean(list.loading),
            error: list.error,
            restoring: list.depth > list.pages && Boolean(list.cursor),
        };
    }

    /** Loads the next page, one at a time; a page that arrives after the data changed is
     * dropped. Resolves with the rows it added (an empty list when there were none, it was
     * dropped or it failed). */
    function loadMore(block) {
        const list = stateOf(block);
        if (!block.more || !list.cursor || !host.load) {
            return Promise.resolve([]);
        }
        if (list.loading) {
            return list.loading.then(() => []);
        }
        const token = list.token;
        const route = resolveTemplate(block.more.route, { ...list.scope, value: list.cursor });
        list.error = null;
        list.loading = (isSafeRoute(route) ? host.load(route) : Promise.reject(new Error("That page points outside its Satellite.")))
            .then((data) => {
                if (token !== list.token) {
                    return [];
                }
                const pageScope = { ...list.scope, data: data || {}, page: data || {} };
                const resolved = resolve(block.items, pageScope);
                const added = [];
                for (const item of Array.isArray(resolved) ? resolved : []) {
                    const key = rowKey(block, item, list.scope);
                    if (key === null || !list.keys.has(key)) {
                        if (key !== null) {
                            list.keys.add(key);
                        }
                        added.push(item);
                    }
                }
                list.extra = list.extra.concat(added);
                list.cursor = nextCursor(resolve(block.more.cursor, pageScope), list.cursor);
                list.pages += 1;
                list.loading = null;
                return added;
            })
            .catch((error) => {
                if (token === list.token) {
                    list.loading = null;
                    list.error = (error && error.message) || "The next rows could not be loaded.";
                }
                return [];
            });
        return list.loading;
    }

    function reset() {
        lists = new Map();
    }

    /** What every list has loaded, to come back to (a history entry left): its rows, keys and
     * cursor, without what is on its way. */
    function snapshot() {
        const kept = new Map();
        for (const [block, list] of lists) {
            if (list.base !== null) {
                kept.set(block, {
                    ...list, extra: list.extra.slice(), keys: new Set(list.keys),
                    loading: null, error: null, depth: 0, kept: true,
                });
            }
        }
        return kept;
    }

    /** Back to a snapshot: the lists show what they had, and the page data that arrives next
     * refreshes their first page without dropping the pages loaded after it. */
    function restore(kept) {
        lists = new Map();
        for (const [block, list] of kept || []) {
            lists.set(block, { ...list, extra: list.extra.slice(), keys: new Set(list.keys), token: list.token + 1 });
        }
    }

    return { rows, status, loadMore, reset, snapshot, restore };
}
