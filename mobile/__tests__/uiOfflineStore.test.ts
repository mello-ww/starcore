import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collectionKey, forgetOfflineSatellite, forgetOfflineServer, keptPages, MAX_AGE, MAX_BYTES, MAX_ENTRIES, MAX_GRID_PAGES,
  keptEntry, OFFLINE_PREFIX, offlinePlan, OfflineStore, purgeLegacyOffline, resetLegacyPurgeForTests, sessionScope,
  tidyOffline,
} from '../src/satellites/ui/offline';

// a page whose grid binds each item's id and blob, and the page's cursor
const PLAN = offlinePlan({blocks: [{type: 'media-grid', items: '$.items', item: {key: '$.id', title: '$.blob'}, more: {route: 'x?c={$value}', cursor: '$.next'}}]});

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
    expect(await store.write('library', entry([{id: 'p1'}, {id: 'p2'}]), PLAN)).toBe(true);
    expect((await store.read('library'))!.data.items.map((item: any) => item.id)).toEqual(['p1', 'p2']);
  });

  it('keeps each server, session, Satellite and collection apart', async () => {
    await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).write('library', entry([{id: 'p1'}]), PLAN);
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
    await store.write('library', entry([{id: 'p1'}], 1000), PLAN);
    now = 1000 + MAX_AGE + 1;
    expect(await store.read('library')).toBeNull();
    expect(await allKeys()).not.toContain(expect.stringContaining('library'));
  });

  it('removes an entry it can’t read, and refuses one too large (forgetting the older copy)', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    await store.write('library', entry([{id: 'p1'}]), PLAN);
    const key = (await allKeys()).find(name => name.endsWith(':library'))!;
    await AsyncStorage.setItem(key, '{"savedAt": 1000, "data": [trunc');
    expect(await store.read('library')).toBeNull();
    expect(await AsyncStorage.getItem(key)).toBeNull();

    await store.write('albums', entry([{id: 'a1'}]), PLAN);
    const huge = entry([{id: 'x', blob: 'x'.repeat(MAX_BYTES)}]);
    expect(await store.write('albums', huge, PLAN)).toBe(false);
    expect(await store.read('albums')).toBeNull();
  });

  it('keeps at most a dozen collections, forgetting the least recently used', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    for (let at = 0; at < MAX_ENTRIES + 3; at += 1) {
      now += 1;
      await store.write(`page${at}`, entry([{id: at}], now), PLAN);
    }
    now += 1;
    expect(await store.read('page0')).toBeNull();
    expect(await store.read('page2')).toBeNull();
    expect(await store.read(`page${MAX_ENTRIES + 2}`)).not.toBeNull();
    expect((await allKeys()).filter(name => !name.includes(':index:'))).toHaveLength(MAX_ENTRIES);
  });

  it('tidies up after an interrupted write and after another session', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    await store.write('library', entry([{id: 'p1'}]), PLAN);
    // written, but never listed: the app stopped between the entry and the index
    await AsyncStorage.setItem(`${OFFLINE_PREFIX}:srv-1:aaaa:Photo:orphan`, JSON.stringify(entry([])));
    // an earlier session's copy
    await new OfflineStore('srv-1', 'old0', 'Photo', clock).write('library', entry([{id: 'stale'}]), PLAN);
    await tidyOffline('srv-1', 'aaaa', now);
    const keys = await allKeys();
    expect(keys.some(name => name.endsWith(':orphan'))).toBe(false);
    expect(keys.some(name => name.includes(':old0:'))).toBe(false);
    expect(await store.read('library')).not.toBeNull();
  });

  it('forgets a Satellite for every session, and a whole server', async () => {
    await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).write('library', entry([{id: 'p1'}]), PLAN);
    await new OfflineStore('srv-1', 'aaaa', 'Other', clock).write('home', entry([{id: 'o1'}]), PLAN);
    await new OfflineStore('srv-2', 'cccc', 'Photo', clock).write('library', entry([{id: 'p9'}]), PLAN);
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

  it('keeps only the fields a page binds, following nested objects and arrays', () => {
    const plan = offlinePlan({
      title: '$.album.name',
      blocks: [
        {type: 'text', text: '$.summary'},
        {type: 'card', blocks: [{type: 'field', label: 'Where', value: '$.place.city'}]},
        {type: 'media-grid', id: 'g', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id', title: '$.title'},
          viewer: {image: 'full/{$.id}', fields: [{label: 'Camera', value: '$.camera'}, {label: 'Album', value: '$page.album.name'}]}},
      ],
    });
    const data = {
      summary: '3 photos', secret: 'x', album: {name: 'Trip', owner: 'someone'}, place: {city: 'Metz', street: 'rue'},
      items: [{id: 'p1', title: 'One', camera: 'X100', extra: 'no', nested: {deep: 1}}],
    };
    const kept = keptEntry({savedAt: 5, data, grids: {g: {pages: [[{id: 'p2', title: 'Two', extra: 'no'}]], cursor: 'c'}, other: {pages: [[{id: 'z'}]], cursor: null}}}, plan);
    expect(kept.data).toEqual({summary: '3 photos', album: {name: 'Trip'}, place: {city: 'Metz'}, items: [{id: 'p1', title: 'One', camera: 'X100'}]});
    expect(kept.grids).toEqual({g: {pages: [[{id: 'p2', title: 'Two'}]], cursor: 'c'}}); // a grid the page doesn't have keeps nothing
  });

  it('leaves out an omitted name at every depth, even where the page binds it', () => {
    const plan = offlinePlan({
      offline: {omit: ['location', 'folder']},
      blocks: [{type: 'media-grid', id: 'g', items: '$.items', item: {key: '$.id'},
        viewer: {fields: [{label: 'Place', value: '$.location'}, {label: 'Folder', value: '$.folder'}, {label: 'Meta', value: '$.meta'}]}}],
    });
    const item = {id: 'p1', location: '49.1, 6.2', folder: '/srv/photos/2026', meta: {a: {location: 'deep', keep: 1}, folder: ['x']}};
    const kept = keptEntry({savedAt: 1, data: {items: [item]}, grids: {g: {pages: [[item]], cursor: null}}}, plan);
    const text = JSON.stringify(kept);
    expect(text).not.toContain('49.1');
    expect(text).not.toContain('/srv/photos');
    expect(text).not.toContain('deep');
    expect(kept.data.items[0]).toEqual({id: 'p1', meta: {a: {keep: 1}}});
    expect(kept.grids.g.pages[0][0]).toEqual({id: 'p1', meta: {a: {keep: 1}}});
  });

  it('writes only what the plan allows', async () => {
    const store = new OfflineStore('srv-1', 'aaaa', 'Photo', clock);
    const plan = offlinePlan({offline: {omit: ['folder']}, blocks: [{type: 'list', items: '$.items', item: {title: '$.name'}}]});
    await store.write('library', {savedAt: 1000, data: {items: [{name: 'One', folder: '/home/x', id: 'p1'}], token: 'abc'}, grids: {}}, plan);
    const raw = (await AsyncStorage.getItem((await allKeys()).find(name => name.endsWith(':library'))!))!;
    expect(JSON.parse(raw).data).toEqual({items: [{name: 'One'}]});
  });

  it('removes every entry the first store kept, for every server, listed or not', async () => {
    resetLegacyPurgeForTests();
    await AsyncStorage.multiSet([
      ['starcore_ui_offline:v1:srv-1:aaaa:Photo:library', '{"data":{"items":[{"location":"49.1, 6.2"}]}}'],
      ['starcore_ui_offline:v1:srv-2:bbbb:Photo:album?id=1', '{}'],
      ['starcore_ui_offline:v1:index:srv-1', '[]'],
      ['starcore_ui_offline:v1:srv-3:cccc:Photo:orphan', '{}'],
      ['starcore_ui_pref:srv-1:Photo', '{"columns":4}'],
    ]);
    await new OfflineStore('srv-1', 'aaaa', 'Photo', clock).write('library', entry([{id: 'p1'}]), PLAN);
    await purgeLegacyOffline();
    const keys = await AsyncStorage.getAllKeys();
    expect(keys.filter(key => key.startsWith('starcore_ui_offline:v1'))).toEqual([]);
    expect(keys).toContain('starcore_ui_pref:srv-1:Photo');
    expect(keys.some(key => key.startsWith(`${OFFLINE_PREFIX}:srv-1:`))).toBe(true);
  });

  it('purges the first store before tidying a server', async () => {
    resetLegacyPurgeForTests();
    await AsyncStorage.setItem('starcore_ui_offline:v1:srv-9:dddd:Photo:library', '{}');
    await tidyOffline('srv-1', 'aaaa', now);
    expect((await AsyncStorage.getAllKeys()).some(key => key.startsWith('starcore_ui_offline:v1'))).toBe(false);
  });
});
