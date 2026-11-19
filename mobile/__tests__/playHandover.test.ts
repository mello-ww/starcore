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

describe('a long list a route answers page by page', () => {
  const pageOf = (from: number, size: number, count: number) =>
    Array.from({length: Math.max(0, Math.min(size, count - from))}, (_, at) => track(`t${from + at}`));
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  /** A player as the handover sees it: a queue the real queue functions build, and listeners. */
  function pagedPlayer() {
    const Q = require('../src/media/queue');
    const listeners = new Set<() => void>();
    const player: any = {
      state: {queue: Q.emptyQueue, context: null, remote: null},
      appended: 0,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(changes: any) {
        player.state = {...player.state, ...changes};
        listeners.forEach(listener => listener());
      },
      playTracks(tracks: Track[], start = 0, context: string | null = null, shuffle?: boolean) {
        player.set({queue: Q.load(tracks, start, shuffle ?? false, 'off', () => 0.5), context});
      },
      playNext() {},
      append(tracks: Track[]) {
        player.appended += tracks.length;
        player.set({queue: Q.append(player.state.queue, tracks)});
      },
      listeners: () => listeners.size,
    };
    return player;
  }

  it('draws every position of a shuffle once, a few at a time', () => {
    const {lazyPositions} = require('../src/media/handover');
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const positions = lazyPositions(10000, random);
    const drawn: number[] = [...positions.draw(100), ...positions.draw(50)];
    expect(positions.left).toBe(9850);
    while (positions.left) {
      drawn.push(...positions.draw(1000));
    }
    expect(new Set(drawn).size).toBe(10000);
    expect(drawn.slice(0, 5)).not.toEqual([0, 1, 2, 3, 4]);
  });

  it('queues the next page when about 25 tracks are left, and stops once the queue is replaced', async () => {
    const asked: any[] = [];
    const load = async (params: any) => {
      asked.push(params);
      const from = Number(params.cursor);
      return {tracks: pageOf(from, 50, 120), count: 120, cursor: from + 50 < 120 ? String(from + 50) : null};
    };
    const player = pagedPlayer();
    const answer = {tracks: pageOf(0, 50, 120), count: 120, cursor: '50'};
    expect(await handOver(player, answer.tracks, {context: 'liked', page: {answer, load}})).toBe(50);
    await settle();
    expect(asked).toEqual([]);
    player.set({queue: {...player.state.queue, position: 30}});
    await settle();
    expect(asked).toEqual([{cursor: '50'}]);
    expect(player.state.queue.tracks).toHaveLength(100);
    expect(player.state.queue.tracks[99].id).toBe('t99');
    // another list replaces it: nothing more is asked for
    player.playTracks([track('x')], 0, 'album:1');
    await settle();
    expect(asked).toHaveLength(1);
    expect(player.listeners()).toBe(0);
  });

  it('shuffles 10,000 tracks from the positions it draws, never asking for the first page again', async () => {
    const asked: string[] = [];
    const load = async (params: any) => {
      asked.push(params.positions);
      const positions = String(params.positions).split(',').map(Number);
      expect(positions.length).toBeLessThanOrEqual(50);
      return {tracks: positions.map(position => track(`t${position}`)), count: 10000};
    };
    const player = pagedPlayer();
    const answer = {tracks: pageOf(0, 100, 10000), count: 10000, cursor: '100'};
    expect(await handOver(player, answer.tracks, {shuffle: true, context: 'liked', page: {answer, load}})).toBe(100);
    expect(player.state.queue.shuffle).toBe(true);
    expect(player.state.queue.tracks).toHaveLength(100);
    const asked100 = asked.flatMap(list => list.split(',').map(Number)).filter(position => position < 100);
    expect(asked100).toEqual([]);
    player.set({queue: {...player.state.queue, position: 80}});
    await settle();
    expect(player.state.queue.tracks).toHaveLength(150);
    expect(new Set(player.state.queue.tracks.map((t: Track) => t.id)).size).toBe(150);
  });
});
