import type {RepeatMode, Track} from './types';

/**
 * The play queue as plain data. `tracks` keeps the order the listener built; `order` is the
 * play order (a permutation of indexes), so shuffling and unshuffling never lose that order.
 */
export interface Queue {
  tracks: Track[];
  order: number[];
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export const emptyQueue: Queue = {tracks: [], order: [], position: 0, shuffle: false, repeat: 'off'};

const identity = (count: number) => Array.from({length: count}, (_, index) => index);

export function shuffled(indexes: number[], random: () => number = Math.random): number[] {
  const copy = [...indexes];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function current(queue: Queue): Track | null {
  const index = queue.order[queue.position];
  return index === undefined ? null : queue.tracks[index] ?? null;
}

export function load(tracks: Track[], start = 0, shuffle = false, repeat: RepeatMode = 'off', random = Math.random): Queue {
  const playable = tracks.filter(track => !track.missing);
  if (!playable.length) {
    return {...emptyQueue, shuffle, repeat};
  }
  const first = Math.max(0, Math.min(start, playable.length - 1));
  let order = identity(playable.length);
  let position = first;
  if (shuffle) {
    order = [first, ...shuffled(order.filter(index => index !== first), random)];
    position = 0;
  }
  return {tracks: playable, order, position, shuffle, repeat};
}

/** The next position, or null at the end of the queue with repeat off. */
export function nextPosition(queue: Queue, manual: boolean): number | null {
  if (!queue.order.length) {
    return null;
  }
  if (queue.repeat === 'one' && !manual) {
    return queue.position;
  }
  if (queue.position + 1 < queue.order.length) {
    return queue.position + 1;
  }
  return queue.repeat === 'off' ? null : 0;
}

export function previousPosition(queue: Queue): number {
  if (queue.position > 0) {
    return queue.position - 1;
  }
  return queue.repeat === 'all' ? Math.max(queue.order.length - 1, 0) : 0;
}

export function setShuffle(queue: Queue, on: boolean, random = Math.random): Queue {
  if (on === queue.shuffle || !queue.order.length) {
    return {...queue, shuffle: on};
  }
  const playing = queue.order[queue.position];
  if (on) {
    const rest = shuffled(identity(queue.tracks.length).filter(index => index !== playing), random);
    return {...queue, shuffle: true, order: [playing, ...rest], position: 0};
  }
  return {...queue, shuffle: false, order: identity(queue.tracks.length), position: playing};
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

/** Inserts right after what is playing. */
export function playNext(queue: Queue, tracks: Track[]): Queue {
  if (!queue.order.length) {
    return load(tracks, 0, queue.shuffle, queue.repeat);
  }
  const base = queue.tracks.length;
  const added = tracks.map((_, offset) => base + offset);
  const order = [...queue.order.slice(0, queue.position + 1), ...added, ...queue.order.slice(queue.position + 1)];
  return {...queue, tracks: [...queue.tracks, ...tracks], order};
}

export function append(queue: Queue, tracks: Track[]): Queue {
  if (!queue.order.length) {
    return load(tracks, 0, queue.shuffle, queue.repeat);
  }
  const base = queue.tracks.length;
  return {...queue, tracks: [...queue.tracks, ...tracks], order: [...queue.order, ...tracks.map((_, i) => base + i)]};
}

/** Removes the entry at a play-order position; the playing track only moves on if it was removed. */
export function removeAt(queue: Queue, position: number): Queue {
  if (position < 0 || position >= queue.order.length) {
    return queue;
  }
  const removed = queue.order[position];
  const tracks = queue.tracks.filter((_, index) => index !== removed);
  const order = queue.order
    .filter((_, index) => index !== position)
    .map(index => (index > removed ? index - 1 : index));
  let current = queue.position;
  if (position < queue.position) {
    current -= 1;
  }
  current = Math.max(0, Math.min(current, order.length - 1));
  return {...queue, tracks, order, position: order.length ? current : 0};
}

export function move(queue: Queue, from: number, to: number): Queue {
  if (from === to || from < 0 || to < 0 || from >= queue.order.length || to >= queue.order.length) {
    return queue;
  }
  const order = [...queue.order];
  const [entry] = order.splice(from, 1);
  order.splice(to, 0, entry);
  let position = queue.position;
  if (from === queue.position) {
    position = to;
  } else if (from < queue.position && to >= queue.position) {
    position -= 1;
  } else if (from > queue.position && to <= queue.position) {
    position += 1;
  }
  return {...queue, order, position};
}

export function clearUpcoming(queue: Queue): Queue {
  const playing = current(queue);
  return playing ? load([playing], 0, queue.shuffle, queue.repeat) : emptyQueue;
}

export function upcoming(queue: Queue): {position: number; track: Track}[] {
  return queue.order.slice(queue.position + 1).map((index, offset) => ({
    position: queue.position + 1 + offset,
    track: queue.tracks[index],
  }));
}

/** The shape the server's queue and Connect routes store: identifiers, list order, play order. */
export function toIds(queue: Queue) {
  return {
    queue: queue.tracks.map(track => track.id),
    order: queue.order,
    index: queue.order[queue.position] ?? 0,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
  };
}

export function fromIds(
  tracks: Track[],
  ids: string[],
  index: number,
  order: number[] | null,
  shuffle: boolean,
  repeat: RepeatMode,
): Queue {
  const byId = new Map(tracks.map(track => [track.id, track]));
  const kept: Track[] = [];
  const remap = new Map<number, number>();
  ids.forEach((id, original) => {
    const track = byId.get(id);
    if (track && !track.missing) {
      remap.set(original, kept.length);
      kept.push(track);
    }
  });
  if (!kept.length) {
    return {...emptyQueue, shuffle, repeat};
  }
  const playOrder =
    order && order.length === ids.length
      ? order.filter(value => remap.has(value)).map(value => remap.get(value)!)
      : identity(kept.length);
  const playing = remap.get(index) ?? 0;
  const position = Math.max(playOrder.indexOf(playing), 0);
  return {tracks: kept, order: playOrder, position, shuffle, repeat};
}
