import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What a shared interface keeps to show while StarCore can't be reached: the data of a page its
 * document marks `"offline": true` (UI contract 1.2), and the pages a media-grid on it loaded
 * after that data. Nothing else, and never on its own initiative.
 *
 * - Scope: per server, per session (a fingerprint of the session's token, never the token),
 *   per Satellite and per collection (a page and its parameters). A new sign-in never reads what
 *   an earlier session kept; sign-out, removing a server, and a 401/403 forget a server's all.
 * - Contents: the page data exactly as the server sent it, and the grid pages loaded after it
 *   with their cursors. No token, no resolved URL, no image: thumbnails stay in the platform's
 *   own image cache, as they do for every screen.
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
export const OFFLINE_PREFIX = 'starcore_ui_offline:v1';
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

  /** Keeps `entry` for `collection`, replacing what was there. False when it is too large to keep
   * (what was there is then forgotten too, so an older copy is never shown instead). */
  async write(collection: string, entry: OfflineEntry): Promise<boolean> {
    const key = this.key(collection);
    let text: string;
    try {
      text = JSON.stringify(entry);
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

/**
 * Tidies a server's store for the session in use: removes what other (earlier) sessions kept,
 * what the index doesn't list (an interrupted write), and what is past MAX_AGE.
 */
export async function tidyOffline(serverId: string, session: string, now: number = Date.now()): Promise<void> {
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
