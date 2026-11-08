import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What a shared interface keeps to show while StarCore can't be reached: the data of a page its
 * document marks `"offline": true` (UI contract 1.2), and the pages a media-grid on it loaded
 * after that data. Nothing else, and never on its own initiative.
 *
 * - Scope: per server, per session (a fingerprint of the session's token, never the token),
 *   per Satellite and per collection (a page and its parameters). A new sign-in never reads what
 *   an earlier session kept; sign-out, removing a server, and a 401/403 forget a server's all.
 * - Contents: only what the page's blocks bind (offlinePlan), from the page data and from the
 *   grid pages loaded after it, with their cursors - and never a field the page names in
 *   `offline.omit`, at any depth. No token, no resolved URL, no image: thumbnails stay in the
 *   platform's own image cache, as they do for every screen. What the first store kept (whole
 *   page data, LEGACY_PREFIXES) is removed at start, for every server (purgeLegacyOffline).
 * - Use: only when StarCore can't be reached - never for an answer that refused the request,
 *   never shown before a live answer has had its chance.
 * - Lifetime: replaced by every live answer; forgotten for a whole Satellite after any action
 *   that changed something there (or when its own screens say an item left); gone after
 *   MAX_AGE; at most MAX_ENTRIES collections per server (least recently used go first) and
 *   MAX_BYTES each.
 * - Storage: one AsyncStorage entry per collection, written before the server's index that
 *   lists it, so an interrupted write leaves either the previous copy or an entry the index
 *   doesn't know, which the next tidy-up removes. An entry that can't be read is removed.
 */
export const OFFLINE_PREFIX = 'starcore_ui_offline:v2';
/** What the first offline store kept: whole page data, possibly with fields a page now omits. */
export const LEGACY_PREFIXES = ['starcore_ui_offline:v1'];
export const MAX_AGE = 7 * 24 * 3600 * 1000;
export const MAX_ENTRIES = 12;
export const MAX_BYTES = 512 * 1024;
/** Grid pages kept after the page data (a library's first 600 items at 120 a page). */
export const MAX_GRID_PAGES = 4;

export interface GridPages {
  /** the items of each page loaded after the page data, in order */
  pages: any[][];
  /** the cursor after the last kept page, or null at the end */
  cursor: string | null;
}

export interface OfflineEntry {
  savedAt: number;
  data: any;
  grids: Record<string, GridPages>;
}

/**
 * What may be kept for a page: the fields its blocks bind, as a tree of paths, and the names it
 * omits. Worked out from the document alone, so it is the same for every Satellite.
 */
export interface OfflinePlan {
  data: PlanNode;
  /** each media-grid's items (by the grid's id): what its pages loaded through `more` keep */
  grids: Record<string, PlanNode>;
  omit: Set<string>;
}

interface PlanNode {
  /** the whole value is bound (`$`, or a field bound as it is): kept, less omitted names */
  all: boolean;
  children: Map<string, PlanNode>;
}

const node = (): PlanNode => ({all: false, children: new Map()});
// bindings into the data a page shows: `$.a.b` (relative to the page data, or to an item inside a
// list), `$page.a.b` (always the page data), `$` (all of it); also inside {placeholders}
const DATA_BINDING = /^\$(?:page)?(?:\.[^.{}\s]+)*$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

function child(parent: PlanNode, path: string[]): PlanNode {
  let at = parent;
  for (const segment of path) {
    let next = at.children.get(segment);
    if (!next) {
      next = node();
      at.children.set(segment, next);
    }
    at = next;
  }
  return at;
}

function bindingsIn(text: string): string[] {
  const found = DATA_BINDING.test(text) ? [text] : [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (DATA_BINDING.test(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

/**
 * Works out what an offline page keeps: every `$.`/`$page.` binding in its title and blocks, with
 * a block's `items` (or `rows`) making `$.` inside it refer to each item as well. Over-keeping a
 * page-level name at item level (or the other way round) costs nothing: it is still only a field
 * the page binds, and `omit` still removes it everywhere.
 */
export function offlinePlan(page: any): OfflinePlan {
  const data = node();
  const grids: Record<string, PlanNode> = {};
  const collections = new Set<PlanNode>();
  const record = (binding: string, bases: string[][]) => {
    const root = binding.startsWith('$page');
    const rest = binding.slice(root ? 5 : 1);
    const path = rest ? rest.slice(1).split('.') : [];
    for (const base of root ? [[]] : bases) {
      const target = child(data, base.concat(path));
      if (!collections.has(target)) {
        target.all = true;
      }
    }
  };
  const walk = (value: any, bases: string[][]) => {
    if (typeof value === 'string') {
      bindingsIn(value).forEach(binding => record(binding, bases));
    } else if (Array.isArray(value)) {
      value.forEach(item => walk(item, bases));
    } else if (value && typeof value === 'object') {
      let inner = bases;
      for (const key of ['items', 'rows']) {
        const source = value[key];
        if (typeof value.type === 'string' && typeof source === 'string' && source.startsWith('$.')) {
          const paths = bases.map(base => base.concat(source.slice(2).split('.')));
          paths.forEach(path => {
            const target = child(data, path);
            target.all = false; // a collection keeps what its items bind, never whole items
            collections.add(target);
          });
          inner = inner.concat(paths);
          if (value.type === 'media-grid') {
            grids[typeof value.id === 'string' && value.id ? value.id : 'grid'] = child(data, paths[0]);
          }
        }
      }
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'items' && key !== 'rows') {
          walk(item, inner);
        }
      }
    }
  };
  walk([page?.title, page?.blocks], [[]]);
  const omit = Array.isArray(page?.offline?.omit) ? page.offline.omit.filter((name: any) => typeof name === 'string') : [];
  return {data, grids, omit: new Set(omit)};
}

/** A value with every omitted name removed, at any depth. */
function withoutOmitted(value: any, omit: Set<string>): any {
  if (Array.isArray(value)) {
    return value.map(item => withoutOmitted(item, omit));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!omit.has(key)) {
        result[key] = withoutOmitted(item, omit);
      }
    }
    return result;
  }
  return value;
}

function project(value: any, plan: PlanNode, omit: Set<string>): any {
  if (plan.all) {
    return withoutOmitted(value, omit);
  }
  if (Array.isArray(value)) {
    return value.map(item => project(item, plan, omit));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, next] of plan.children) {
      if (!omit.has(key) && Object.prototype.hasOwnProperty.call(value, key)) {
        result[key] = project(value[key], next, omit);
      }
    }
    return result;
  }
  return value;
}

/** An entry reduced to what its page may keep: bound fields only, omitted names nowhere. */
export function keptEntry(entry: OfflineEntry, plan: OfflinePlan): OfflineEntry {
  const grids: Record<string, GridPages> = {};
  for (const [id, pages] of Object.entries(entry.grids)) {
    const items = plan.grids[id];
    if (items && Array.isArray(pages?.pages)) {
      grids[id] = {
        pages: pages.pages.map(page => (Array.isArray(page) ? page.map(item => project(item, items, plan.omit)) : [])),
        cursor: typeof pages.cursor === 'string' ? pages.cursor : null,
      };
    }
  }
  return {savedAt: entry.savedAt, data: project(entry.data, plan.data, plan.omit), grids};
}

interface IndexRow {
  key: string;
  usedAt: number;
}

/** A short, one-way fingerprint of a session token (FNV-1a): enough to keep two sessions apart. */
export function sessionScope(token: string | null | undefined): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < (token ?? '').length; at += 1) {
    hash ^= (token as string).charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return token ? hash.toString(16).padStart(8, '0') : 'none';
}

/** A collection's name: its page and parameters, the same whatever order they come in. */
export function collectionKey(page: string, params: Record<string, unknown> = {}): string {
  const query = Object.keys(params)
    .sort()
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(params[name] ?? ''))}`)
    .join('&');
  return query ? `${page}?${query}` : page;
}

const serverPrefix = (serverId: string) => `${OFFLINE_PREFIX}:${serverId}:`;
const indexKey = (serverId: string) => `${OFFLINE_PREFIX}:index:${serverId}`;

async function readIndex(serverId: string): Promise<IndexRow[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(indexKey(serverId))) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(row => row && typeof row.key === 'string' && typeof row.usedAt === 'number') : [];
  } catch {
    return [];
  }
}

function isEntry(value: any): value is OfflineEntry {
  return Boolean(value) && typeof value.savedAt === 'number' && 'data' in value && value.grids && typeof value.grids === 'object';
}

/** One server's offline store, for one session and one Satellite. */
export class OfflineStore {
  constructor(
    private serverId: string,
    private session: string,
    private satellite: string,
    private now: () => number = Date.now,
  ) {}

  private key(collection: string): string {
    return `${serverPrefix(this.serverId)}${this.session}:${encodeURIComponent(this.satellite)}:${collection}`;
  }

  private satellitePrefix(): string {
    return `${serverPrefix(this.serverId)}${this.session}:${encodeURIComponent(this.satellite)}:`;
  }

  /** What was kept for `collection`, or null (never kept, too old, unreadable). */
  async read(collection: string): Promise<OfflineEntry | null> {
    const key = this.key(collection);
    let parsed: any = null;
    try {
      const raw = await AsyncStorage.getItem(key);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = undefined; // unreadable: removed below
    }
    if (parsed === null) {
      return null;
    }
    if (!isEntry(parsed) || this.now() - parsed.savedAt > MAX_AGE) {
      await this.forgetKeys([key]);
      return null;
    }
    await this.touch(key);
    return parsed;
  }

  /** Keeps what `plan` allows of `entry` for `collection`, replacing what was there. False when
   * it is too large to keep (what was there is then forgotten too, so an older copy is never
   * shown instead). The entry is reduced and serialized before anything is awaited, so a caller
   * adding grid pages afterwards never changes what this call writes. */
  async write(collection: string, entry: OfflineEntry, plan: OfflinePlan): Promise<boolean> {
    const key = this.key(collection);
    let text: string;
    try {
      text = JSON.stringify(keptEntry(entry, plan));
    } catch {
      return false;
    }
    if (text.length > MAX_BYTES) {
      await this.forgetKeys([key]);
      return false;
    }
    try {
      await AsyncStorage.setItem(key, text); // the entry first: the index only ever lists what exists
      await this.touch(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets every collection of this Satellite, for this session. */
  async forgetSatellite(): Promise<void> {
    const prefix = this.satellitePrefix();
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(prefix));
      await this.forgetKeys(keys);
    } catch {
      // storage unavailable: nothing could be read from it either
    }
  }

  private async touch(key: string): Promise<void> {
    const rows = (await readIndex(this.serverId)).filter(row => row.key !== key);
    rows.push({key, usedAt: this.now()});
    rows.sort((a, b) => b.usedAt - a.usedAt);
    const kept = rows.slice(0, MAX_ENTRIES);
    const evicted = rows.slice(MAX_ENTRIES).map(row => row.key);
    try {
      await AsyncStorage.setItem(indexKey(this.serverId), JSON.stringify(kept));
      if (evicted.length) {
        await AsyncStorage.multiRemove(evicted);
      }
    } catch {
      // the index is rebuilt from what tidy() finds
    }
  }

  private async forgetKeys(keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    try {
      await AsyncStorage.multiRemove(keys);
      const gone = new Set(keys);
      const rows = (await readIndex(this.serverId)).filter(row => !gone.has(row.key));
      await AsyncStorage.setItem(indexKey(this.serverId), JSON.stringify(rows));
    } catch {
      // nothing more to do
    }
  }
}

let legacyPurged = false;

/**
 * Removes everything an earlier offline store kept (LEGACY_PREFIXES): every server and session,
 * listed in an index or not. Called when the app starts and before any tidy-up; once it has
 * succeeded it does nothing more in this run, and a failure is tried again next time.
 */
export async function purgeLegacyOffline(): Promise<void> {
  if (legacyPurged) {
    return;
  }
  try {
    const legacy = (await AsyncStorage.getAllKeys()).filter(key =>
      LEGACY_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}:`)),
    );
    if (legacy.length) {
      await AsyncStorage.multiRemove(legacy);
    }
    legacyPurged = true;
  } catch {
    // storage unavailable: tried again by the next call
  }
}

/** For tests: forgets that this run already purged. */
export function resetLegacyPurgeForTests(): void {
  legacyPurged = false;
}

/**
 * Tidies a server's store for the session in use: removes what other (earlier) sessions kept,
 * what the index doesn't list (an interrupted write), and what is past MAX_AGE.
 */
export async function tidyOffline(serverId: string, session: string, now: number = Date.now()): Promise<void> {
  await purgeLegacyOffline();
  try {
    const prefix = serverPrefix(serverId);
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(prefix));
    const rows = await readIndex(serverId);
    const listed = new Map(rows.map(row => [row.key, row.usedAt]));
    const mine = `${prefix}${session}:`;
    const stale = keys.filter(key => !key.startsWith(mine) || !listed.has(key) || now - (listed.get(key) as number) > MAX_AGE);
    const present = new Set(keys);
    const kept = rows.filter(row => present.has(row.key) && row.key.startsWith(mine) && now - row.usedAt <= MAX_AGE);
    if (stale.length) {
      await AsyncStorage.multiRemove(stale);
    }
    await AsyncStorage.setItem(indexKey(serverId), JSON.stringify(kept));
  } catch {
    // storage unavailable: nothing to tidy
  }
}

/** Forgets everything kept for a server: sign-out, a removed server, a refused session. */
export async function forgetOfflineServer(serverId: string): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(
      key => key.startsWith(serverPrefix(serverId)) || key === indexKey(serverId),
    );
    if (keys.length) {
      await AsyncStorage.multiRemove(keys);
    }
  } catch {
    // nothing kept, or storage unavailable
  }
}

/** Forgets one Satellite's collections on a server, for every session - for a Satellite's own
 * screens when an item leaves (deleted, moved somewhere private), whatever session kept them. */
export async function forgetOfflineSatellite(serverId: string, satellite: string): Promise<void> {
  try {
    const marker = `:${encodeURIComponent(satellite)}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter(
      key => key.startsWith(serverPrefix(serverId)) && key.slice(serverPrefix(serverId).length).includes(marker),
    );
    if (keys.length) {
      await AsyncStorage.multiRemove(keys);
    }
  } catch {
    // nothing kept, or storage unavailable
  }
}

/** The grid pages to keep: the first MAX_GRID_PAGES, and the cursor after the last of them. */
export function keptPages(pages: any[][], cursors: (string | null)[]): GridPages {
  const count = Math.min(pages.length, MAX_GRID_PAGES);
  return {pages: pages.slice(0, count), cursor: count ? cursors[count - 1] ?? null : null};
}
