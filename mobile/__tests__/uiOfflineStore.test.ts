import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collectionKey, forgetOfflineSatellite, forgetOfflineServer, keptPages, MAX_AGE, MAX_BYTES, MAX_ENTRIES, MAX_GRID_PAGES,
  OFFLINE_PREFIX, OfflineStore, sessionScope, tidyOffline,
} from '../src/satellites/ui/offline';

// The store behind offline pages (UI contract 1.2): scoped, bounded, and forgiving of a
// storage that was cut off mid-write or holds something it can't read.

const entry = (items: any[], savedAt = 1000) => ({savedAt, data: {items, next: null}, grids: {}});
const allKeys = async () => (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(OFFLINE_PREFIX));

describe('the offline store', () => {
  let now = 1000;
  const clock = () => now;
  beforeEach(async () => {
    now = 1000;
    await AsyncStorage.clear();
  });

  it('keeps a page’s data and gives it back', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    expect(await store.read('library')).toBeNull();
    expect(await store.write('library', entry([{id: 'p1'}, {id: 'p2'}]))).toBe(true);
    expect((await store.read('library'))!.data.items.map((item: any) => item.id)).toEqual(['p1', 'p2']);
  });

  it('keeps each server, session, Satellite and collection apart', async () => {
    await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).write('library', entry([{id: 'p1'}]));
    expect(await new OfflineStore('srv-2', 'aaaa', 'Photo', clock).read('library')).toBeNull();
    expect(await new OfflineStore('srv-1', 'bbbb', 'Photo', clock).read('library')).toBeNull();
    expect(await new OfflineStore('srv-1', 'aaaa', 'Other', clock).read('library')).toBeNull();
    expect(await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).read(collectionKey('album', {id: '7'}))).toBeNull();
    expect(collectionKey('album', {b: 2, a: 1})).toBe(collectionKey('album', {a: 1, b: 2}));
  });

  it('names a session by a fingerprint, never by its token', () => {
    const token = 'secret-token-value';
    const scope = sessionScope(token);
    expect(scope).toMatch(/^[0-9a-f]{8}$/);
    expect(scope).not.toContain('secret');
    expect(sessionScope('another-token')).not.toBe(scope);
    expect(sessionScope(null)).toBe('none');
  });

  it('forgets what is older than a week', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    await store.write('library', entry([{id: 'p1'}], 1000));
    now = 1000 + MAX_AGE + 1;
    expect(await store.read('library')).toBeNull();
    expect(await allKeys()).not.toContain(expect.stringContaining('library'));
  });

  it('removes an entry it can’t read, and refuses one too large (forgetting the older copy)', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    await store.write('library', entry([{id: 'p1'}]));
    const key = (await allKeys()).find(name => name.endsWith(':library'))!;
    await AsyncStorage.setItem(key, '{"savedAt": 1000, "data": [trunc');
    expect(await store.read('library')).toBeNull();
    expect(await AsyncStorage.getItem(key)).toBeNull();

    await store.write('albums', entry([{id: 'a1'}]));
    const huge = entry([{id: 'x', blob: 'x'.repeat(MAX_BYTES)}]);
    expect(await store.write('albums', huge)).toBe(false);
    expect(await store.read('albums')).toBeNull();
  });

  it('keeps at most a dozen collections, forgetting the least recently used', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    for (let at = 0; at < MAX_ENTRIES + 3; at += 1) {
      now += 1;
      await store.write(`page${at}`, entry([{id: at}], now));
    }
    now += 1;
    expect(await store.read('page0')).toBeNull();
    expect(await store.read('page2')).toBeNull();
    expect(await store.read(`page${MAX_ENTRIES + 2}`)).not.toBeNull();
    expect((await allKeys()).filter(name => !name.includes(':index:'))).toHaveLength(MAX_ENTRIES);
  });

  it('tidies up after an interrupted write and after another session', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    await store.write('library', entry([{id: 'p1'}]));
    // written, but never listed: the app stopped between the entry and the index
    await AsyncStorage.setItem(`${OFFLINE_PREFIX}:srv-1:aaaa:Photo:orphan`, JSON.stringify(entry([])));
    // an earlier session's copy
    await new OfflineStore('srv-1', 'old0', 'Photo', clock).write('library', entry([{id: 'stale'}]));
    await tidyOffline('srv-1', 'aaaa', now);
    const keys = await allKeys();
    expect(keys.some(name => name.endsWith(':orphan'))).toBe(false);
    expect(keys.some(name => name.includes(':old0:'))).toBe(false);
    expect(await store.read('library')).not.toBeNull();
  });

  it('forgets a Satellite for every session, and a whole server', async () => {
    await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).write('library', entry([{id: 'p1'}]));
    await new OfflineStore('srv-1', 'aaaa', 'Other', clock).write('home', entry([{id: 'o1'}]));
    await new OfflineStore('srv-2', 'cccc', 'Photo', clock).write('library', entry([{id: 'p9'}]));
    await forgetOfflineSatellite('srv-1', 'Photo');
    expect(await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).read('library')).toBeNull();
    expect(await new OfflineStore('srv-1', 'aaaa', 'Other', clock).read('home')).not.toBeNull();
    await forgetOfflineServer('srv-1');
    expect((await allKeys()).every(name => !name.includes('srv-1'))).toBe(true);
    expect(await new OfflineStore('srv-2', 'cccc', 'Photo', clock).read('library')).not.toBeNull();
  });

  it('keeps a grid’s first pages with the cursor after them', () => {
    const pages = Array.from({length: MAX_GRID_PAGES + 2}, (_, at) => [{id: at}]);
    const cursors = pages.map((_, at) => `c${at}`);
    expect(keptPages(pages, cursors)).toEqual({pages: pages.slice(0, MAX_GRID_PAGES), cursor: `c${MAX_GRID_PAGES - 1}`});
    expect(keptPages([[{id: 1}]], [null])).toEqual({pages: [[{id: 1}]], cursor: null});
    expect(keptPages([], [])).toEqual({pages: [], cursor: null});
  });
});
