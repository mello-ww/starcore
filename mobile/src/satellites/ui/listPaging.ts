import {isSafeRoute, resolve, resolveTemplate, type Scope, type UiBlock} from './contract';

/**
 * A list that arrives page by page (UI contract 1.2, `more` on a list): the page data holds the
 * first page and the provider's cursor for the next; each further page comes from `more.route`
 * with that cursor as $value, in the page data's own shape. The provider owns the cursor - this
 * only passes it back. The same rules as Mission Control's (mission_control/ui/listpaging.js);
 * pure state, so __tests__/uiListPaging.test.ts checks it without a screen.
 */
export interface ListPagingStatus {
  /** There is a next page. */
  more: boolean;
  /** One is on its way. */
  loading: boolean;
  /** Why the last one failed, else null. */
  error: string | null;
  /** A refresh is still loading back the pages it had. */
  restoring: boolean;
}

interface ListState {
  base: any[] | null;
  collection: string | null;
  extra: any[];
  keys: Set<string>;
  cursor: unknown;
  scope: Scope | null;
  loading: Promise<any[]> | null;
  error: string | null;
  token: number;
  pages: number;
  depth: number;
}

/** null at the end: none, empty, or the same cursor again (which would only fetch the same page). */
function nextCursor(value: unknown, previous: unknown): unknown {
  return value === null || value === undefined || value === '' || value === previous ? null : value;
}

/** A row's identity, to never show one twice when a provider's pages overlap. */
function rowKey(item: unknown): string | null {
  try {
    return JSON.stringify(item) ?? null;
  } catch {
    return null;
  }
}

export function createListPaging(host: {load?: (route: string) => Promise<any>}) {
  let lists = new WeakMap<UiBlock, ListState>();

  function stateOf(block: UiBlock): ListState {
    let list = lists.get(block);
    if (!list) {
      list = {
        base: null, collection: null, extra: [], keys: new Set(), cursor: null,
        scope: null, loading: null, error: null, token: 0, pages: 0, depth: 0,
      };
      lists.set(block, list);
    }
    return list;
  }

  /** The page data changed (first load, a refresh, another folder): the list starts again from
   * it. A refresh of the same collection loads as many pages again as were loaded. */
  function adopt(block: UiBlock, list: ListState, base: any[], scope: Scope) {
    const collection = resolveTemplate(block.more.route, {...scope, value: ''});
    const same = collection === list.collection && list.base !== null;
    list.depth = same ? list.pages : 0;
    list.base = base;
    list.collection = collection;
    list.extra = [];
    list.keys = new Set(base.map(rowKey).filter((key): key is string => key !== null));
    list.pages = 0;
    list.token += 1; // any page still on its way belongs to the old data
    list.loading = null;
    list.error = null;
    list.cursor = nextCursor(resolve(block.more.cursor, scope), null);
  }

  /** Every row to draw now: the page data's own, then the pages loaded after them. */
  function rows(block: UiBlock, scope: Scope): any[] {
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
    return (list.base ?? []).concat(list.extra);
  }

  function status(block: UiBlock): ListPagingStatus {
    const list = stateOf(block);
    return {
      more: Boolean(list.cursor),
      loading: Boolean(list.loading),
      error: list.error,
      restoring: list.depth > list.pages && Boolean(list.cursor),
    };
  }

  /** Loads the next page, one at a time; a page that arrives after the data changed is dropped.
   * Resolves with the rows it added (none when there were none, it was dropped or it failed). */
  function loadMore(block: UiBlock): Promise<any[]> {
    const list = stateOf(block);
    if (!block.more || !list.cursor || !host.load) {
      return Promise.resolve([]);
    }
    if (list.loading) {
      return list.loading.then(() => []);
    }
    const token = list.token;
    const route = resolveTemplate(block.more.route, {...(list.scope as Scope), value: list.cursor});
    list.error = null;
    const request = isSafeRoute(route) ? host.load(route) : Promise.reject(new Error('That page points outside its Satellite.'));
    list.loading = request
      .then(data => {
        if (token !== list.token) {
          return [];
        }
        const pageScope = {...(list.scope as Scope), data: data ?? {}, page: data ?? {}};
        const resolved = resolve(block.items, pageScope);
        const added: any[] = [];
        for (const item of Array.isArray(resolved) ? resolved : []) {
          const key = rowKey(item);
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
      .catch((error: any) => {
        if (token === list.token) {
          list.loading = null;
          list.error = error?.message || 'The next rows could not be loaded.';
        }
        return [];
      });
    return list.loading;
  }

  function reset() {
    lists = new WeakMap();
  }

  return {rows, status, loadMore, reset};
}

export type ListPaging = ReturnType<typeof createListPaging>;
