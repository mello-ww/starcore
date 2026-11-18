import {handOver, playable} from '../src/media/handover';
import type {Track} from '../src/media/types';

function track(id: string, extra: Partial<Track> = {}): Track {
  return {id, title: id, artist: 'A', album: 'B', duration: 60, ...extra} as Track;
}

function fakePlayer() {
  const calls: any[] = [];
  return {
    calls,
    playTracks: (tracks: Track[], start?: number, context?: string | null, shuffle?: boolean) =>
      calls.push(['playTracks', tracks.map(t => t.id), start, context, shuffle]),
    playNext: (tracks: Track[]) => calls.push(['playNext', tracks.map(t => t.id)]),
    append: (tracks: Track[]) => calls.push(['append', tracks.map(t => t.id)]),
  };
}

describe("a page's tracks handed to the audio host", () => {
  it('keeps only tracks with an id that are not missing', () => {
    const list = playable([track('a'), null, 'b', {title: 'no id'}, track('c', {missing: true}), track('d')]);
    expect(list.map(t => t.id)).toEqual(['a', 'd']);
    expect(playable('not a list')).toEqual([]);
  });

  it('replaces the queue from the track asked for, keeping the shuffle setting', async () => {
    const player = fakePlayer();
    expect(await handOver(player, [track('a'), track('b'), track('c')], {start: 'b', context: 'album:1'})).toBe(3);
    expect(player.calls).toEqual([['playTracks', ['a', 'b', 'c'], 1, 'album:1', undefined]]);
  });

  it('starts from the first track when the one asked for is not there', async () => {
    const player = fakePlayer();
    await handOver(player, [track('a'), track('b')], {start: 'zz'});
    expect(player.calls).toEqual([['playTracks', ['a', 'b'], 0, null, undefined]]);
  });

  it('shuffles from any track, turning shuffle on', async () => {
    const player = fakePlayer();
    await handOver(player, [track('a'), track('b'), track('c'), track('d')], {shuffle: true}, () => 0.6);
    expect(player.calls).toEqual([['playTracks', ['a', 'b', 'c', 'd'], 2, null, true]]);
  });

  it('adds to the queue next or at the end without replacing it', async () => {
    const player = fakePlayer();
    await handOver(player, [track('a')], {queue: 'next', start: 'a', shuffle: true});
    await handOver(player, [track('b')], {queue: 'end'});
    expect(player.calls).toEqual([
      ['playNext', ['a']],
      ['append', ['b']],
    ]);
  });

  it('cuts a long context and plays nothing from an empty list', async () => {
    const player = fakePlayer();
    await handOver(player, [track('a')], {context: 'x'.repeat(200)});
    expect(player.calls[0][3]).toHaveLength(80);
    expect(await handOver(player, [], {})).toBe(0);
    expect(player.calls).toHaveLength(1);
  });
});
