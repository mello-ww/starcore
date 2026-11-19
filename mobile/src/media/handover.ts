// Tracks a Satellite's own page hands to the audio host (the UI contract's play action with
// `tracks` or `route`, 1.2): which of them can be played, how they join the queue, and how a
// long list a route answers page by page keeps the queue fed. Kept apart from AudioHost, which
// draws, so the rule is tested on its own; Mission Control has the same rule in
// mission_control/media/handover.js.
import type {Queue} from './queue';
import type {Track} from './types';

/** When this many queued tracks or fewer are left, the next page is asked for. */
export const LOW_WATER = 25;
/** How many positions a shuffle draws at first, and then each time it runs low. */
export const SHUFFLE_AHEAD = 100;
export const SHUFFLE_REFILL = 50;
/** At most this many positions in one request. */
export const POSITIONS_PER_REQUEST = 50;

/** A route's answer: {tracks, count?, cursor?, context?}. */
export interface PageAnswer {
  tracks?: unknown;
  count?: unknown;
  cursor?: unknown;
}

/** One page of a longer list, and how to ask the same route for more: `cursor` for the next
 * page in order, `positions` (comma-separated) for the tracks at those positions. */
export interface PagedPlay {
  answer: PageAnswer | null | undefined;
  load: (params: {cursor?: string; positions?: string}) => Promise<PageAnswer | null | undefined>;
}

export interface HandOverOptions {
  /** The id of the track to start from; the first track when absent or not in the list. */
  start?: unknown;
  shuffle?: boolean;
  /** "next" plays them after the current track, "end" adds them at the end of the queue. */
  queue?: unknown;
  context?: unknown;
  /** A route's paged answer: the queue is fed from it as it plays. */
  page?: PagedPlay | null;
}

/** What the handover needs of the player. */
export interface HandOverPlayer {
  playTracks(tracks: Track[], start?: number, context?: string | null, shuffle?: boolean): Promise<unknown> | unknown;
  playNext(tracks: Track[]): unknown;
  append(tracks: Track[]): unknown;
  /** For a paged list only: the queue as it changes. */
  subscribe?(listener: () => void): () => void;
  state?: {queue: Queue; context: string | null; remote?: unknown};
}

/** The tracks of a handed-over list that can be played: objects with an id, not missing. */
export function playable(tracks: unknown): Track[] {
  return (Array.isArray(tracks) ? tracks : []).filter(
    (track): track is Track =>
      !!track && typeof track === 'object' && typeof (track as any).id === 'string' && !!(track as any).id && !(track as any).missing,
  );
}

/** Whether a route's answer is one page of a longer list ({tracks, count, cursor}). */
export function isPaged(answer: PageAnswer | null | undefined): boolean {
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.tracks)) {
    return false;
  }
  const more = typeof answer.cursor === 'string' && answer.cursor !== '';
  const larger = Number.isInteger(answer.count) && (answer.count as number) > answer.tracks.length;
  return more || larger;
}

/** A random order of the positions 0..count-1, drawn a few at a time: a partial Fisher-Yates
 * over the indexes, which only remembers the positions it swapped, so shuffling 10,000 tracks
 * costs what is drawn, not the whole list. */
export function lazyPositions(count: number, random: () => number = Math.random) {
  const swapped = new Map<number, number>();
  let drawn = 0;
  const at = (index: number) => (swapped.has(index) ? (swapped.get(index) as number) : index);
  return {
    get left() {
      return count - drawn;
    },
    draw(wanted: number): number[] {
      const out: number[] = [];
      while (out.length < wanted && drawn < count) {
        const other = drawn + Math.floor(random() * (count - drawn));
        const picked = at(other);
        swapped.set(other, at(drawn));
        swapped.delete(drawn);
        out.push(picked);
        drawn += 1;
      }
      return out;
    },
  };
}

export interface PagedSource {
  shuffled: boolean;
  readonly more: boolean;
  take(wanted: number): Promise<Track[]>;
}

function shuffledList<T>(list: T[], random: () => number): T[] {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** The rest of a paged list, after its first page. With `shuffle` and a `count`, positions are
 * drawn lazily; the first page's tracks are the positions 0 to its length. */
export function pagedSource(
  first: PageAnswer,
  load: PagedPlay['load'],
  {shuffle = false, random = Math.random}: {shuffle?: boolean; random?: () => number} = {},
): PagedSource {
  const count = Number.isInteger(first.count) ? (first.count as number) : null;
  if (shuffle && count !== null) {
    const positions = lazyPositions(count, random);
    const firstPage: unknown[] = Array.isArray(first.tracks) ? first.tracks : [];
    return {
      shuffled: true,
      get more() {
        return positions.left > 0;
      },
      async take(wanted: number) {
        const drawn = positions.draw(wanted);
        const found = new Map<number, unknown>();
        const missing: number[] = [];
        for (const position of drawn) {
          if (position < firstPage.length) {
            found.set(position, firstPage[position]);
          } else {
            missing.push(position);
          }
        }
        for (let index = 0; index < missing.length; index += POSITIONS_PER_REQUEST) {
          const chunk = missing.slice(index, index + POSITIONS_PER_REQUEST);
          const answer = await load({positions: chunk.join(',')});
          const tracks: unknown[] = Array.isArray(answer?.tracks) ? (answer?.tracks as unknown[]) : [];
          chunk.forEach((position, at) => found.set(position, tracks[at]));
        }
        return playable(drawn.map(position => found.get(position)));
      },
    };
  }
  let cursor = typeof first.cursor === 'string' && first.cursor ? first.cursor : null;
  return {
    shuffled: false,
    get more() {
      return cursor !== null;
    },
    async take() {
      if (cursor === null) {
        return [];
      }
      const answer = await load({cursor});
      cursor = typeof answer?.cursor === 'string' && answer.cursor ? answer.cursor : null;
      const tracks = playable(answer?.tracks);
      return shuffle ? shuffledList(tracks, random) : tracks;
    },
  };
}

/** What `follow` needs of the queue. */
export interface FedQueue {
  subscribe(listener: () => void): () => void;
  left(): number;
  /** Whether the queue is still the one handed over. */
  still(): boolean;
  add(tracks: Track[]): unknown;
}

/** Keeps the queue fed from `source` while it is still the one handed over: each time the
 * player changes, when `LOW_WATER` tracks or fewer are left, the next tracks are added at the
 * end. It stops once the queue was replaced or the source is spent. Returns the stop function. */
export function follow(queue: FedQueue, source: PagedSource): () => void {
  let busy = false;
  let stopped = false;
  let unsubscribe = () => {};
  const stop = () => {
    stopped = true;
    unsubscribe();
  };
  const check = async () => {
    if (stopped || busy) {
      return;
    }
    if (!source.more || !queue.still()) {
      stop();
      return;
    }
    if (queue.left() > LOW_WATER) {
      return;
    }
    busy = true;
    try {
      const tracks = await source.take(SHUFFLE_REFILL);
      if (!stopped && queue.still() && tracks.length) {
        await queue.add(tracks);
      }
    } catch {
      stop(); // the list ends here; what is queued still plays
    } finally {
      busy = false;
    }
    if (!stopped && !source.more) {
      stop();
    }
  };
  unsubscribe = queue.subscribe(() => {
    check();
  });
  check();
  return stop;
}

const following = new WeakMap<object, () => void>();

function playerQueue(player: HandOverPlayer, first: Track): FedQueue | null {
  const state = () => player.state;
  if (!player.subscribe || !state()) {
    return null;
  }
  const context = state()!.context;
  let seen: Queue | null = null;
  let held = true;
  return {
    subscribe: listener => player.subscribe!(listener),
    left: () => {
      const queue = state()!.queue;
      return queue.order.length - queue.position - 1;
    },
    still: () => {
      const current = state()!;
      if (current.context !== context) {
        return false;
      }
      // the queue changes on every append and move, and keeps its track objects
      if (current.queue !== seen) {
        seen = current.queue;
        held = current.queue.tracks.includes(first);
      }
      return held;
    },
    add: tracks => player.append(tracks),
  };
}

/** Plays `tracks` on `player` as the action asks: `queue` ("next" or "end") adds them,
 * `shuffle` shuffles them (turning shuffle on), otherwise they replace the queue from `start`.
 * `context` is cut to 80 characters. With `page` (a route's paged answer, and `load` to ask for
 * more), the queue is fed as it plays: in order, or with `shuffle` from positions drawn lazily
 * over the whole list. Resolves with how many tracks were taken at first. */
export async function handOver(
  player: HandOverPlayer,
  tracks: unknown,
  options: HandOverOptions = {},
  random: () => number = Math.random,
): Promise<number> {
  const context = typeof options.context === 'string' && options.context ? options.context.slice(0, 80) : null;
  const page = options.page && isPaged(options.page.answer) && !options.queue ? options.page : null;
  let source: PagedSource | null = null;
  let list = playable(tracks);
  if (page) {
    source = pagedSource(page.answer as PageAnswer, page.load, {shuffle: options.shuffle === true, random});
    if (source.shuffled) {
      list = await source.take(SHUFFLE_AHEAD);
    }
  }
  if (!list.length) {
    return 0;
  }
  following.get(player)?.();
  following.delete(player);
  if (options.queue === 'next') {
    await player.playNext(list);
  } else if (options.queue === 'end') {
    await player.append(list);
  } else if (options.shuffle) {
    // any track may come first, as on the web
    await player.playTracks(list, Math.floor(random() * list.length), context, true);
  } else {
    // the person's own shuffle setting stays as it is
    const at = options.start == null ? -1 : list.findIndex(track => track.id === String(options.start));
    await player.playTracks(list, Math.max(0, at), context, undefined);
  }
  if (source?.more && !player.state?.remote) {
    const queue = playerQueue(player, list[0]);
    if (queue) {
      following.set(player, follow(queue, source));
    }
  }
  return list.length;
}
