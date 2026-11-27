// The offline action (UI contract 1.2, change 10, docs/reference/media-audio.md): a page of the Satellite
// that provides audio.library names tracks of its own - `tracks` (a binding, or a list of
// bindings) or `route` (one of its routes answering {tracks}, paged or not) - and the app keeps
// them on the phone through the audio host's DownloadManager, at the listener's download
// quality, network rule and storage limit. The document supplies no path, URL or setting, and no
// label: the control's text and state are the app's. Pure, so __tests__/offlineAction.test.ts
// checks it without a screen.
import {isSafeRoute, resolve, resolveTemplate, type Scope} from '../satellites/ui/contract';
import {playable} from './handover';
import type {Track} from './types';

/** At most this many tracks are kept by one press. */
export const OFFLINE_MAX_TRACKS = 2000;
/** And a route's answer is followed for at most this many pages. */
export const OFFLINE_MAX_PAGES = 100;

export interface OfflineSpec {
  tracks?: unknown;
  route?: string;
}

/** What the action needs of the download manager. */
export interface OfflineKeeper {
  isDownloaded(trackId: string): boolean;
  jobs: {track: {id: string}; status: string}[];
  enqueue(tracks: Track[]): Promise<{queued: number; blocked?: string}>;
  remove(trackId: string): Promise<void>;
}

export interface OfflineState {
  total: number;
  kept: number;
  /** queued or downloading now */
  downloading: number;
  failed: number;
}

export interface OfflineDeps {
  /** The Satellite's own routes, with this session. */
  load: (route: string) => Promise<any>;
  keeper: OfflineKeeper;
  /** Asks before removing: resolves true to go ahead. */
  confirm: (title: string, button: string, message: string) => Promise<boolean>;
  notify: (message: string, error?: boolean) => void;
}

/** The tracks a `tracks` spec names, from the page alone (a route's are known once loaded). */
export function boundTracks(spec: OfflineSpec | null | undefined, scope: Scope): Track[] | null {
  if (!spec || spec.tracks === undefined) {
    return null;
  }
  const value = Array.isArray(spec.tracks) ? spec.tracks.map(item => resolve(item, scope)) : resolve(spec.tracks, scope);
  return playable(value).slice(0, OFFLINE_MAX_TRACKS);
}

/** The tracks the action keeps: the page's, or every page its route answers (following
 * `cursor`), at most OFFLINE_MAX_TRACKS. */
export async function offlineTracks(spec: OfflineSpec, scope: Scope, load: OfflineDeps['load']): Promise<Track[]> {
  if (spec.route === undefined) {
    return boundTracks(spec, scope) ?? [];
  }
  const route = resolveTemplate(spec.route, scope);
  if (!isSafeRoute(route)) {
    throw new Error('That action points outside its Satellite and was refused.');
  }
  const joiner = route.includes('?') ? '&' : '?';
  const found: unknown[] = [];
  let answer = await load(route);
  // a Satellite that answers a cursor with no tracks, or the same cursor again, stops here
  const seen = new Set<string>();
  for (let pages = 1; ; pages++) {
    found.push(...(Array.isArray(answer?.tracks) ? answer.tracks : []));
    const cursor = answer?.cursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor) || found.length >= OFFLINE_MAX_TRACKS || pages >= OFFLINE_MAX_PAGES) {
      break;
    }
    seen.add(cursor);
    answer = await load(`${route}${joiner}cursor=${encodeURIComponent(cursor)}`);
  }
  return playable(found).slice(0, OFFLINE_MAX_TRACKS);
}

/** How many of the tracks are kept, on their way, or failed. */
export function offlineState(keeper: Pick<OfflineKeeper, 'isDownloaded' | 'jobs'>, tracks: Track[]): OfflineState {
  const jobs = new Map(keeper.jobs.map(job => [job.track.id, job.status]));
  const state: OfflineState = {total: tracks.length, kept: 0, downloading: 0, failed: 0};
  for (const track of tracks) {
    if (keeper.isDownloaded(track.id)) {
      state.kept += 1;
    } else if (jobs.get(track.id) === 'failed') {
      state.failed += 1;
    } else if (jobs.has(track.id)) {
      state.downloading += 1;
    }
  }
  return state;
}

/** The control's text, the app's own: a button says Download, Downloading 3 of 12 or
 * Downloaded (pressed, it offers Remove download); a menu entry for one track says Download,
 * Downloading… or Remove download. Unknown tracks (a route not loaded yet) say Download. */
export function offlineLabel(state: OfflineState | null, entry = false): string {
  if (!state || !state.total) {
    return 'Download';
  }
  if (state.downloading > 0) {
    return entry ? 'Downloading…' : `Downloading ${state.kept} of ${state.total}`;
  }
  if (state.kept === state.total) {
    return entry ? 'Remove download' : 'Downloaded';
  }
  return 'Download';
}

/** Runs the action: keeps what isn't kept yet, or - when every track already is - asks, then
 * removes them. Resolves with whether something was done. */
export async function runOffline(spec: OfflineSpec, scope: Scope, deps: OfflineDeps): Promise<boolean> {
  let tracks: Track[];
  try {
    tracks = await offlineTracks(spec, scope, deps.load);
  } catch (err: any) {
    deps.notify(err?.payload?.message || err?.message || 'Could not download that.', true);
    return false;
  }
  if (!tracks.length) {
    deps.notify('There is nothing to download here.', true);
    return false;
  }
  const state = offlineState(deps.keeper, tracks);
  if (state.kept === state.total) {
    const one = tracks.length === 1;
    const asked = await deps.confirm(
      one ? 'Remove download' : 'Remove downloads',
      'Remove',
      one ? `Remove "${tracks[0].title ?? 'this song'}" from this phone?` : `Remove these ${tracks.length} songs from this phone?`,
    );
    if (!asked) {
      return false;
    }
    for (const track of tracks) {
      await deps.keeper.remove(track.id);
    }
    deps.notify(one ? 'Download removed.' : `${tracks.length} downloads removed.`);
    return true;
  }
  const result = await deps.keeper.enqueue(tracks);
  if (result.blocked) {
    deps.notify(result.blocked, true);
    return false;
  }
  deps.notify(
    result.queued
      ? `Downloading ${result.queued} ${result.queued === 1 ? 'song' : 'songs'}.`
      : 'Already downloading.',
  );
  return true;
}
