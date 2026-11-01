import AsyncStorage from '@react-native-async-storage/async-storage';
import {DownloadManager, type DownloadSettings} from '../src/music/downloads';
import type {DownloadNative} from '../src/music/native';
import {musicKeys} from '../src/music/storage';
import {makeTracks} from './musicFakes';

function fakeNative() {
  const files = new Map<string, number>();
  const native: DownloadNative & {files: Map<string, number>; calls: any[]} = {
    files,
    calls: [],
    download: jest.fn(async (id, url, headers, relative) => {
      native.calls.push({id, url, headers, relative});
      files.set(relative, 4 * 1024 * 1024);
      return {path: `/data/files/music/${relative}`, size: 4 * 1024 * 1024};
    }),
    cancel: jest.fn(async () => true),
    remove: jest.fn(async relative => files.delete(relative)),
    exists: jest.fn(async relative => (files.has(relative) ? `/data/files/music/${relative}` : null)),
    usage: jest.fn(async () => ({used: 0, free: 1e9})),
    onProgress: jest.fn(() => () => undefined),
  };
  return native;
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function manager(serverId: string, native: DownloadNative | null, network = 'wifi', settings: Partial<DownloadSettings> = {}) {
  let clock = 1000;
  return new DownloadManager(
    serverId,
    'https://music.test',
    () => 'secret-token',
    native,
    async () => network as any,
    () => ({quality: 'original', format: 'opus', network: 'wifi', limitMb: 2048, ...settings}),
    () => (clock += 1000),
  );
}

describe('DownloadManager', () => {
  beforeEach(() => AsyncStorage.clear());

  it('downloads into the server-specific folder with the token as a header only', async () => {
    const native = fakeNative();
    const downloads = manager('server-a', native);
    const tracks = makeTracks(2);
    expect((await downloads.enqueue(tracks)).queued).toBe(2);
    await settle();
    expect(native.calls[0].relative).toBe(`server-a/tracks/${tracks[0].id}.audio`);
    expect(native.calls[0].headers).toEqual({Authorization: 'Bearer secret-token'});
    expect(native.calls[0].url).toBe(`https://music.test/api/satellites/music/stream/${tracks[0].id}?quality=original`);
    expect(native.calls[0].url).not.toContain('secret');
    expect(downloads.localUri(tracks[0].id)).toBe(`file:///data/files/music/server-a/tracks/${tracks[0].id}.audio`);
    const stored = JSON.parse((await AsyncStorage.getItem(musicKeys.downloads('server-a')))!);
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(tracks.map(track => track.id)));
  });

  it('refuses to start on cellular when downloads are Wi-Fi only, but allows any network when set', async () => {
    const native = fakeNative();
    expect((await manager('s', native, 'cellular').enqueue(makeTracks(1))).blocked).toMatch(/Wi-Fi/);
    expect(native.download).not.toHaveBeenCalled();
    const anyNetwork = manager('s', native, 'cellular', {network: 'any'});
    expect((await anyNetwork.enqueue(makeTracks(1))).queued).toBe(1);
  });

  it('uses the download quality, so a transcode can be stored instead of the original', async () => {
    const native = fakeNative();
    const downloads = manager('s', native, 'wifi', {quality: 'normal'});
    await downloads.enqueue(makeTracks(1));
    await settle();
    expect(native.calls[0].url).toContain('quality=normal&format=opus');
  });

  it('removes the least recently played downloads once over the storage limit', async () => {
    const native = fakeNative();
    const downloads = manager('s', native, 'wifi', {limitMb: 9});
    const tracks = makeTracks(3);
    await downloads.enqueue([tracks[0], tracks[1]]);
    await settle();
    await downloads.markPlayed(tracks[0].id);
    await downloads.enqueue([tracks[2]]);
    await settle();
    expect(downloads.isDownloaded(tracks[0].id)).toBe(true);
    expect(downloads.isDownloaded(tracks[1].id)).toBe(false);
    expect(downloads.isDownloaded(tracks[2].id)).toBe(true);
    expect(native.remove).toHaveBeenCalledWith(`s/tracks/${tracks[1].id}.audio`);
  });

  it('searches downloaded songs offline', async () => {
    const downloads = manager('s', fakeNative());
    await downloads.enqueue(makeTracks(2));
    await settle();
    expect(downloads.search('song a1').map(track => track.title)).toEqual(['Song a1']);
    expect(downloads.search('nothing')).toEqual([]);
  });

  it('keeps each server apart', async () => {
    const native = fakeNative();
    const first = manager('server-a', native);
    await first.enqueue(makeTracks(1));
    await settle();
    const second = manager('server-b', native);
    await second.ready();
    expect(second.list()).toEqual([]);
    const reopened = manager('server-a', native);
    await reopened.ready();
    expect(reopened.list()).toHaveLength(1);
  });

  it('records a failure without losing the queue, and retries on request', async () => {
    const native = fakeNative();
    (native.download as jest.Mock).mockRejectedValueOnce(new Error('the server answered 503'));
    const downloads = manager('s', native);
    await downloads.enqueue(makeTracks(1));
    await settle();
    expect(downloads.jobs[0].status).toBe('failed');
    expect(downloads.jobs[0].error).toContain('503');
    downloads.retryFailed();
    await settle();
    expect(downloads.jobs).toHaveLength(0);
    expect(downloads.list()).toHaveLength(1);
  });

  it('reports that downloads need the Android app when the native module is absent', async () => {
    const downloads = manager('s', null);
    expect(downloads.supported).toBe(false);
    expect((await downloads.enqueue(makeTracks(1))).blocked).toBeTruthy();
  });

  it('caches notification artwork locally because the media notification cannot send headers', async () => {
    const native = fakeNative();
    const downloads = manager('s', native);
    const uri = await downloads.artworkFile('ab01ab01ab01ab01');
    expect(uri).toBe('file:///data/files/music/s/artwork/ab01ab01ab01ab01.jpg');
    expect(await downloads.artworkFile('ab01ab01ab01ab01')).toBe(uri);
    expect(native.download).toHaveBeenCalledTimes(1);
    expect(await downloads.artworkFile('../../etc')).toBeNull();
  });
});
