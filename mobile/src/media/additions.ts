// What the audio host adds to its player from the document of the Satellite it plays from (UI
// contract 1.2, change 9: the document's `audio`, docs/reference/media-audio.md): menu entries after the
// host's own, the title's and artist's links, and a way to the Satellite's pages, each run with
// the playing track as $. and no page around it. A navigate opens that page of the Satellite's
// shared interface wherever the player is. The same rules as Mission Control's
// mission_control/media/document.js; pure, so __tests__/audioAdditions.test.ts checks them
// without a screen.
import {runChoose, type ChooseAnswer, type ChooseOffer} from '../satellites/ui/choose';
import {isSafeRoute, isVisible, resolve, resolveTemplate, type Scope, type UiAction, type UiAudio} from '../satellites/ui/contract';
import type {PagedPlay} from './handover';
import type {Track} from './types';

export interface AdditionDeps {
  /** opens a page of the Satellite's shared interface */
  open: (page: string, params: Record<string, string>) => void;
  play: (tracks: unknown, options: {start?: unknown; shuffle?: boolean; queue?: unknown; context?: unknown; page?: PagedPlay | null}) => Promise<number>;
  playSearch: (text: string) => Promise<number>;
  /** the Satellite's routes, rejecting with its error */
  load: (route: string) => Promise<any>;
  post: (route: string, body: any) => Promise<any>;
  choose: (offer: ChooseOffer) => Promise<ChooseAnswer>;
  confirm: (text: string) => Promise<boolean>;
  /** what the app keeps of that capability, read again */
  reload: (capability: string) => Promise<void> | void;
  notify: (message: string, error?: boolean) => void;
  /** change 18: opens the folder holding a path in whichever Satellite browses files; resolves
   * with whether it opened */
  locate?: (path: string) => Promise<boolean>;
}

export interface AdditionEntry {
  label: string;
  icon?: string;
  action: UiAction;
}

function refused(): Error {
  return new Error('That action points outside its Satellite and was refused.');
}

const asText = (value: unknown) => (value === null || value === undefined ? '' : String(value));

function asParams(value: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null && item !== undefined) {
        params[key] = String(item);
      }
    }
  }
  return params;
}

/** The menu entries shown for a track: those whose `visible` holds, labels resolved. */
export function menuEntries(audio: UiAudio | null | undefined, track: Track | null): AdditionEntry[] {
  const scope: Scope = {data: track ?? {}};
  return (Array.isArray(audio?.menu) ? audio!.menu : [])
    .filter(entry => entry && entry.action && (entry.visible === undefined || isVisible(resolve(entry.visible, scope))))
    .map(entry => ({label: asText(resolve(entry.label, scope)), icon: entry.icon, action: entry.action}));
}

/** The action a link runs for the id the player shows (one of several artists, say), which
 * stands in for the track's own; null without one. */
export function linkAction(audio: UiAudio | null | undefined, kind: 'album' | 'artist', track: Track, id: string | null | undefined): {action: UiAction; track: Track} | null {
  const action = audio?.[kind];
  if (!action || !id) {
    return null;
  }
  return {action, track: {...track, [`${kind}_id`]: id} as Track};
}

/** Runs one of the `audio` section's actions for a track; resolves with whether it ran. */
export function additionRunner(deps: AdditionDeps) {
  return async function run(action: UiAction | undefined, track: Track | null): Promise<boolean> {
    if (!action || typeof action !== 'object') {
      return false;
    }
    const scope: Scope = {data: track ?? {}};
    try {
      if (action.navigate) {
        deps.open(action.navigate, asParams(resolve(action.params ?? {}, scope)));
        return true;
      }
      if (action.play) {
        return await play(action.play, scope, deps);
      }
      if (action.locate !== undefined) {
        // change 18: the playing track keeps no path, so `route` (the Satellite's own, read with
        // the track) answers the $. the path is read from
        let from = scope;
        if (action.route !== undefined) {
          const route = resolveTemplate(action.route, scope);
          if (!isSafeRoute(route)) {
            throw refused();
          }
          from = {data: (await deps.load(route)) ?? {}};
        }
        const path = resolve(action.locate, from);
        if (!deps.locate) {
          deps.notify("That isn't available in this app.", true);
          return false;
        }
        if (typeof path !== 'string' || !path) {
          deps.notify("That file isn't in a folder you can browse.", true);
          return false;
        }
        return await deps.locate(path);
      }
      let result: any;
      if (action.choose) {
        const outcome = await runChoose(action, scope, {
          load: deps.load,
          choose: deps.choose,
          request: deps.post,
          confirm: deps.confirm,
        });
        if (!outcome) {
          return false; // cancelled: nothing more runs
        }
        result = outcome.result;
      } else if (action.route !== undefined) {
        if (action.confirm && !(await deps.confirm(asText(resolve(action.confirm, scope))))) {
          return false;
        }
        const route = resolveTemplate(action.route, scope);
        if (!isSafeRoute(route)) {
          throw refused();
        }
        result = action.method === 'GET'
          ? await deps.load(route)
          : await deps.post(route, action.body !== undefined ? resolve(action.body, scope) : {});
      } else {
        return false;
      }
      if (typeof result?.message === 'string') {
        deps.notify(result.message);
      }
      if (typeof action.reloads === 'string') {
        await deps.reload(action.reloads);
      }
      return true;
    } catch (err: any) {
      deps.notify(err?.payload?.message || err?.message || 'That did not work.', true);
      return false;
    }
  };
}

async function play(spec: NonNullable<UiAction['play']>, scope: Scope, deps: AdditionDeps): Promise<boolean> {
  if (spec.search !== undefined) {
    const found = await deps.playSearch(asText(resolve(spec.search, scope)));
    if (!found) {
      deps.notify('Nothing to play was found.', true);
    }
    return found > 0;
  }
  let tracks: unknown;
  let page: PagedPlay | null = null;
  let context: unknown = spec.context === undefined ? undefined : resolve(spec.context, scope);
  if (spec.route !== undefined) {
    const route = resolveTemplate(spec.route, scope);
    if (!isSafeRoute(route)) {
      throw refused();
    }
    const answer = await deps.load(route);
    tracks = answer?.tracks;
    if (spec.context === undefined && typeof answer?.context === 'string') {
      context = answer.context;
    }
    const joiner = route.includes('?') ? '&' : '?';
    page = {
      answer,
      load: params =>
        deps.load(`${route}${joiner}${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`),
    };
  } else {
    tracks = resolve(spec.tracks, scope);
  }
  const played = await deps.play(tracks, {
    start: spec.start === undefined ? undefined : resolve(spec.start, scope),
    shuffle: spec.shuffle === true,
    queue: spec.queue,
    context,
    page,
  });
  if (!played) {
    deps.notify('There is nothing to play here.', true);
  }
  return played > 0;
}
