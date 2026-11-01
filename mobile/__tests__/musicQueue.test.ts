import * as Q from '../src/music/queue';
import {makeTracks} from './musicFakes';

const seeded = () => {
  let seed = 7;
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
};

describe('music queue', () => {
  const tracks = makeTracks(5);

  it('starts at the chosen track and walks forward, stopping at the end with repeat off', () => {
    let queue = Q.load(tracks, 2);
    expect(Q.current(queue)?.id).toBe(tracks[2].id);
    queue = {...queue, position: Q.nextPosition(queue, true)!};
    queue = {...queue, position: Q.nextPosition(queue, true)!};
    expect(Q.current(queue)?.id).toBe(tracks[4].id);
    expect(Q.nextPosition(queue, false)).toBeNull();
  });

  it('wraps with repeat all and stays on the track with repeat one unless skipped', () => {
    const all = {...Q.load(tracks, 4), repeat: 'all' as const};
    expect(Q.nextPosition(all, false)).toBe(0);
    const one = {...Q.load(tracks, 1), repeat: 'one' as const};
    expect(Q.nextPosition(one, false)).toBe(1);
    expect(Q.nextPosition(one, true)).toBe(2);
    expect(Q.cycleRepeat('off')).toBe('all');
    expect(Q.cycleRepeat('all')).toBe('one');
    expect(Q.cycleRepeat('one')).toBe('off');
  });

  it('shuffles around the playing track and unshuffles back to the original order', () => {
    const queue = Q.load(tracks, 3);
    const shuffled = Q.setShuffle(queue, true, seeded());
    expect(Q.current(shuffled)?.id).toBe(tracks[3].id);
    expect(shuffled.position).toBe(0);
    expect([...shuffled.order].sort()).toEqual([0, 1, 2, 3, 4]);
    const back = Q.setShuffle(shuffled, false);
    expect(back.order).toEqual([0, 1, 2, 3, 4]);
    expect(Q.current(back)?.id).toBe(tracks[3].id);
  });

  it('skips unavailable tracks when loading', () => {
    const queue = Q.load([...tracks.slice(0, 2), {...tracks[2], missing: true}], 0);
    expect(queue.tracks).toHaveLength(2);
  });

  it('plays next right after the current track and appends at the end', () => {
    const extra = makeTracks(2, 'x');
    let queue = Q.load(tracks, 1);
    queue = Q.playNext(queue, [extra[0]]);
    expect(Q.upcoming(queue)[0].track.id).toBe(extra[0].id);
    queue = Q.append(queue, [extra[1]]);
    const upcoming = Q.upcoming(queue);
    expect(upcoming[upcoming.length - 1].track.id).toBe(extra[1].id);
    expect(Q.current(queue)?.id).toBe(tracks[1].id);
  });

  it('removes and moves entries without losing the playing track', () => {
    let queue = Q.load(tracks, 2);
    queue = Q.removeAt(queue, 0);
    expect(Q.current(queue)?.id).toBe(tracks[2].id);
    queue = Q.move(queue, 3, 2);
    expect(Q.current(queue)?.id).toBe(tracks[2].id);
    expect(Q.upcoming(queue)[0].track.id).toBe(tracks[4].id);
    queue = Q.clearUpcoming(queue);
    expect(queue.tracks).toHaveLength(1);
  });

  it('round-trips through the identifiers the server stores', () => {
    const queue = Q.setShuffle(Q.load(tracks, 1), true, seeded());
    const ids = Q.toIds(queue);
    const restored = Q.fromIds(tracks, ids.queue, ids.index, ids.order, ids.shuffle, ids.repeat);
    expect(Q.current(restored)?.id).toBe(Q.current(queue)?.id);
    expect(restored.order).toEqual(queue.order);
  });

  it('restores what it can when some tracks are no longer known', () => {
    const ids = tracks.map(track => track.id);
    const restored = Q.fromIds(tracks.slice(1), ids, 3, null, false, 'off');
    expect(restored.tracks).toHaveLength(4);
    expect(Q.current(restored)?.id).toBe(tracks[3].id);
  });
});
