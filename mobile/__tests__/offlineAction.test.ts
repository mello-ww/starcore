import AsyncStorage from '@react-native-async-storage/async-storage';
import {DownloadManager} from '../src/media/downloads';
import type {DownloadNative} from '../src/media/native';
import {boundTracks, offlineLabel, offlineState, offlineTracks, runOffline, type OfflineDeps} from '../src/media/offlineAction';
import {makeTracks, testLibrary} from './musicFakes';

// The offline action (UI contract 1.2, change 10): a page names its own tracks, and the app keeps
// them through the audio host's DownloadManager - queued, held by the network rule, removed.

function fakeNative(): DownloadNative {
  const files = new Set<string>();
  return {
    download: jest.fn(async (_id, _url, _headers, relative) => {
      files.add(relative);
      return {path: `/data/files/music/${relative}`, size: 1024};
    }),
    cancel: jest.fn(async () => true),
    remove: jest.fn(async relative => files.delete(relative)),
    exists: jest.fn(async relative => (files.has(relative) ? `/data/files/music/${relative}` : null)),
    usage: jest.fn(async () => ({used: 0, free: 1e9})),
    onProgress: jest.fn(() => () => undefined),
  };
}

function manager(network = 'wifi', rule: 'wifi' | 'any' = 'wifi') {
  let clock = 1000;
  return new DownloadManager(
    'server',
    'https://server.test',
    () => testLibrary(),
    () => 'token',
    fakeNative(),
    async () => network as any,
    () => ({quality: 'high', format: 'opus', network: rule, limitMb: 2048}),
    () => (clock += 1000),
  );
}

async function settle() {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}

function deps(keeper: DownloadManager, overrides: Partial<OfflineDeps> = {}) {
  const notes: {message: string; error?: boolean}[] = [];
  const value: OfflineDeps & {notes: typeof notes} = {
    notes,
    load: jest.fn(async () => ({tracks: []})),
    keeper,
    confirm: jest.fn(async () => true),
    notify: (message, error) => notes.push({message, error}),
    ...overrides,
  };
  return value;
}

describe('the offline action', () => {
  beforeEach(() => AsyncStorage.clear());

  it("binds the page's tracks, a list of bindings, or follows a route's pages", async () => {
    const tracks = makeTracks(3);
    const scope = {data: {tracks, one: tracks[1]}};
    expect(boundTracks({tracks: '$.tracks'}, scope)?.map(track => track.id)).toEqual(tracks.map(track => track.id));
    expect(boundTracks({tracks: ['$.one']}, scope)?.map(track => track.id)).toEqual([tracks[1].id]);
    expect(boundTracks({route: 'mixes/1'}, scope)).toBeNull();
    const load = jest.fn(async (route: string) =>
      route.includes('cursor=') ? {tracks: tracks.slice(2), cursor: null} : {tracks: tracks.slice(0, 2), cursor: 'next page'});
    const found = await offlineTracks({route: 'mixes/{$.id}'}, {data: {id: 7}}, load);
    expect(found).toHaveLength(3);
    expect(load.mock.calls.map(call => call[0])).toEqual(['mixes/7', 'mixes/7?cursor=next%20page']);
    await expect(offlineTracks({route: '../files'}, {data: {}}, load)).rejects.toThrow(/refused/);
  });

  it('stops following a route that repeats its cursor or never ends', async () => {
    const same = jest.fn(async () => ({tracks: [], cursor: 'again'}));
    expect(await offlineTracks({route: 'mixes/1'}, {data: {}}, same)).toEqual([]);
    expect(same).toHaveBeenCalledTimes(2);
    let page = 0;
    const endless = jest.fn(async () => ({tracks: [], cursor: `page ${++page}`}));
    await offlineTracks({route: 'mixes/1'}, {data: {}}, endless);
    expect(endless).toHaveBeenCalledTimes(100);
  });

  it('queues what is not kept yet, and the label follows', async () => {
    const keeper = manager();
    const tracks = makeTracks(2);
    const run = deps(keeper);
    expect(offlineLabel(offlineState(keeper, tracks))).toBe('Download');
    expect(await runOffline({tracks: '$.tracks'}, {data: {tracks}}, run)).toBe(true);
    expect(run.notes).toEqual([{message: 'Downloading 2 songs.', error: undefined}]);
    expect(offlineLabel(offlineState(keeper, tracks))).toMatch(/^Downloading \d of 2$/);
    await settle();
    expect(offlineState(keeper, tracks)).toEqual({total: 2, kept: 2, downloading: 0, failed: 0});
    expect(offlineLabel(offlineState(keeper, tracks))).toBe('Downloaded');
    expect(offlineLabel(offlineState(keeper, tracks.slice(0, 1)), true)).toBe('Remove download');
  });

  it('is held by the network rule, and says so', async () => {
    const keeper = manager('cellular', 'wifi');
    const tracks = makeTracks(1);
    const run = deps(keeper);
    expect(await runOffline({tracks: ['$']}, {data: tracks[0]}, run)).toBe(false);
    expect(run.notes).toEqual([{message: 'Downloads are set to Wi-Fi only.', error: true}]);
    expect(keeper.jobs).toHaveLength(0);
    const anyNetwork = manager('cellular', 'any');
    expect(await runOffline({tracks: ['$']}, {data: tracks[0]}, deps(anyNetwork))).toBe(true);
  });

  it('removes what is all kept, once the listener agrees', async () => {
    const keeper = manager();
    const tracks = makeTracks(2);
    await keeper.enqueue(tracks);
    await settle();
    const declined = deps(keeper, {confirm: jest.fn(async () => false)});
    expect(await runOffline({tracks: '$.tracks'}, {data: {tracks}}, declined)).toBe(false);
    expect(keeper.isDownloaded(tracks[0].id)).toBe(true);
    const run = deps(keeper);
    expect(await runOffline({tracks: '$.tracks'}, {data: {tracks}}, run)).toBe(true);
    expect(run.confirm).toHaveBeenCalledWith('Remove downloads', 'Remove', 'Remove these 2 songs from this phone?');
    expect(tracks.some(track => keeper.isDownloaded(track.id))).toBe(false);
    expect(run.notes).toEqual([{message: '2 downloads removed.', error: undefined}]);
  });

  it('says when there is nothing to keep', async () => {
    const run = deps(manager());
    expect(await runOffline({tracks: '$.tracks'}, {data: {tracks: [{id: 'x', missing: true}]}}, run)).toBe(false);
    expect(run.notes[0]).toEqual({message: 'There is nothing to download here.', error: true});
  });
});
