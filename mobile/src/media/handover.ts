// Tracks a Satellite's own page hands to the audio host (the UI contract's play action with
// `tracks` or `route`, 1.2): which of them can be played, and how they join the queue. Kept
// apart from AudioHost, which draws, so the rule is tested on its own; Mission Control has the
// same rule in mission_control/media/handover.js.
import type {Track} from './types';

export interface HandOverOptions {
  /** The id of the track to start from; the first track when absent or not in the list. */
  start?: unknown;
  shuffle?: boolean;
  /** "next" plays them after the current track, "end" adds them at the end of the queue. */
  queue?: unknown;
  context?: unknown;
}

/** What the handover needs of the player. */
export interface HandOverPlayer {
  playTracks(tracks: Track[], start?: number, context?: string | null, shuffle?: boolean): Promise<unknown> | unknown;
  playNext(tracks: Track[]): unknown;
  append(tracks: Track[]): unknown;
}

/** The tracks of a handed-over list that can be played: objects with an id, not missing. */
export function playable(tracks: unknown): Track[] {
  return (Array.isArray(tracks) ? tracks : []).filter(
    (track): track is Track =>
      !!track && typeof track === 'object' && typeof (track as any).id === 'string' && !!(track as any).id && !(track as any).missing,
  );
}

/** Plays `tracks` on `player` as the action asks: `queue` ("next" or "end") adds them,
 * `shuffle` shuffles them (turning shuffle on), otherwise they replace the queue from `start`.
 * `context` is cut to 80 characters. Resolves with how many tracks were taken. */
export async function handOver(
  player: HandOverPlayer,
  tracks: unknown,
  options: HandOverOptions = {},
  random: () => number = Math.random,
): Promise<number> {
  const list = playable(tracks);
  if (!list.length) {
    return 0;
  }
  const context = typeof options.context === 'string' && options.context ? options.context.slice(0, 80) : null;
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
  return list.length;
}
