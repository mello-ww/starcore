import type {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import type {ConnectDevice, ConnectEvent, Lyrics, MusicPreferences, PlaybackInfo, Quality, QueueState, Track} from './types';

/**
 * The audio library the AudioHost plays from: whichever Satellite the capability catalog
 * (`GET /api/catalog`) lists first as an enabled `audio.library` v1 provider. Nothing here
 * names a Satellite: every URL is built from the provider's catalog entry. See
 * docs/media-audio.md.
 */

/** One provider as `/api/catalog` lists it. */
export interface CatalogProvider {
  satellite: string;
  version: number;
  operations: Record<string, string>;
  enabled: boolean;
}

export type Catalog = Record<string, CatalogProvider[] | undefined>;

export const AUDIO_LIBRARY = 'audio.library';
/** The playback session a provider may offer beside its library: the saved queue, play
 * history, radio, listener preferences, likes, a stream route and StarCore Connect. Not yet
 * in the shared vocabulary, so the Engine registers it as declared; the host uses each
 * operation only when the same Satellite declares it. */
export const AUDIO_SESSION = 'audio.session';
const LIBRARY_VERSIONS = [1];

export interface AudioProvider {
  satellite: string;
  /** audio.library's operations: search, track, resolve, artwork, maybe lyrics. */
  operations: Record<string, string>;
  /** audio.session's operations from the same Satellite, or an empty map. */
  session: Record<string, string>;
}

/**
 * The provider to play from: the first enabled `audio.library` v1 provider, with that
 * Satellite's `audio.session` operations. `fallback` covers servers older than the
 * capability (the released Alpha), whose catalog lists no audio library.
 */
export function resolveAudioProvider(catalog: Catalog | null | undefined, fallback: AudioProvider | null = null): AudioProvider | null {
  const library = (catalog?.[AUDIO_LIBRARY] ?? []).find(entry => entry.enabled && LIBRARY_VERSIONS.includes(entry.version));
  if (!library) {
    return catalog?.[AUDIO_LIBRARY]?.length ? null : fallback;
  }
  const session = (catalog?.[AUDIO_SESSION] ?? []).find(entry => entry.enabled && entry.satellite === library.satellite);
  return {satellite: library.satellite, operations: library.operations, session: session?.operations ?? {}};
}

const enc = encodeURIComponent;

export class UnsupportedError extends ApiError {
  constructor(operation: string) {
    super(`This audio library doesn't offer ${operation}.`, 0);
  }
}

/** Requests to the resolved provider, by operation. */
export class AudioLibraryClient {
  private settle: () => void = () => undefined;
  /** Settles once the provider is known (or known to be absent). */
  readonly ready: Promise<void>;

  constructor(private client: StarCoreClient, public provider: AudioProvider | null = null) {
    this.ready = provider ? Promise.resolve() : new Promise(resolve => (this.settle = resolve));
  }

  /** The host resolves the provider after it reads the catalog; one client lives for the
   * whole session, so the player that holds it never has to be rebuilt. */
  setProvider(provider: AudioProvider | null) {
    this.provider = provider;
    this.settle();
  }

  /** The provider's API path, e.g. "/api/satellites/<name>", or null without a provider. */
  get path(): string | null {
    return this.provider ? `/api/satellites/${enc(this.provider.satellite)}` : null;
  }

  offers(operation: string): boolean {
    return Boolean(this.provider?.operations[operation]);
  }

  offersSession(operation: string): boolean {
    return Boolean(this.provider?.session[operation]);
  }

  /** A route inside the provider, `<route>/<rest>`, for a URL or a request. */
  private route(table: 'operations' | 'session', operation: string, rest = ''): string {
    const route = this.provider?.[table][operation];
    if (!route) {
      throw new UnsupportedError(operation);
    }
    return `${this.path}/${route}${rest}`;
  }

  /** An absolute URL inside the provider, for media the player or Image loads itself. */
  url(baseUrl: string, relative: string): string {
    return `${baseUrl}${this.path}/${relative}`;
  }

  artworkPath(albumId: string, size: number): string | null {
    return this.offers('artwork') ? `${this.provider!.operations.artwork}/${enc(albumId)}?size=${size}` : null;
  }

  /** The stream route the session names, for a track the resolve step couldn't plan. */
  streamPath(trackId: string, quality: Quality, format: string): string | null {
    if (!this.offersSession('stream')) {
      return null;
    }
    const query = quality === 'original' ? 'quality=original' : `quality=${quality}&format=${format}`;
    return `${this.provider!.session.stream}/${enc(trackId)}?${query}`;
  }

  private async get<T>(path: string, fallback: string): Promise<T> {
    const {status, body} = await this.client.get(path);
    if (status !== 200) {
      throw new ApiError(body?.error || fallback, status);
    }
    return body as T;
  }

  private async post<T>(path: string, payload: unknown, fallback: string): Promise<T> {
    const {status, body} = await this.client.post(path, payload ?? {});
    if (status !== 200 && status !== 201) {
      throw new ApiError(body?.error || fallback, status);
    }
    return body as T;
  }

  // ---------- audio.library v1 ----------

  playback(trackId: string, quality: Quality) {
    return this.get<PlaybackInfo>(this.route('operations', 'resolve', `/${enc(trackId)}?quality=${quality}`), 'Could not prepare playback.');
  }

  track(id: string) {
    return this.get<Track>(this.route('operations', 'track', `/${enc(id)}`), 'Could not load this track.');
  }

  lyrics(trackId: string, language?: string) {
    return this.get<Lyrics>(this.route('operations', 'lyrics', `/${enc(trackId)}${language ? `?language=${enc(language)}` : ''}`), 'No lyrics.');
  }

  setLyricsOffset(trackId: string, offset: number) {
    return this.post(this.route('operations', 'lyrics', `/${enc(trackId)}`), {offset}, 'Could not save the offset.');
  }

  // ---------- audio.session (optional) ----------

  preferences() {
    return this.get<MusicPreferences>(this.route('session', 'preferences'), 'Could not load playback settings.');
  }

  updatePreferences(changes: Partial<MusicPreferences>) {
    return this.post<MusicPreferences>(this.route('session', 'preferences'), changes, 'Could not save playback settings.');
  }

  favorites() {
    return this.get<{ids: Record<string, string[]>}>(this.route('session', 'favorites'), 'Could not load your likes.');
  }

  setFavorite(kind: 'track' | 'album' | 'artist' | 'playlist', ids: string[], liked: boolean) {
    return this.post<{ids: Record<string, string[]>}>(this.route('session', 'favorites'), {kind, ids, liked}, 'Could not update your likes.');
  }

  recordPlay(trackId: string, seconds: number, device: string, context: string | null) {
    return this.post(this.route('session', 'history'), {track_id: trackId, seconds, device, context}, 'Could not record the play.');
  }

  radio(kind: 'track' | 'artist' | 'album' | 'genre', id: string) {
    return this.get<{tracks: Track[]}>(this.route('session', 'radio', `/${kind}/${enc(id)}`), 'Could not start the radio.');
  }

  async savedQueue(device: string) {
    return (await this.get<{state: (QueueState & {tracks?: Track[]}) | null}>(
      this.route('session', 'queue', `?device=${enc(device)}&expand=1`),
      'Could not load the queue.',
    )).state;
  }

  saveQueue(device: string, state: QueueState, name: string) {
    return this.post(this.route('session', 'queue'), {device, state, name, kind: 'mobile'}, 'Could not save the queue.');
  }

  registerDevice(deviceId: string, name: string) {
    return this.post<{cursor: number}>(
      this.route('session', 'connect', '/register'),
      {device_id: deviceId, name, kind: 'mobile', capabilities: {play: true, remote: true, volume: true, offline: true}},
      'Could not register this device.',
    );
  }

  devices() {
    return this.get<{devices: ConnectDevice[]; active: {device: string; state: QueueState} | null}>(
      this.route('session', 'connect', '/devices'),
      'Could not load devices.',
    );
  }

  publishState(deviceId: string, state: QueueState) {
    return this.post(this.route('session', 'connect', '/state'), {device_id: deviceId, state}, 'Could not publish playback state.');
  }

  command(deviceId: string, target: string, command: string, args: Record<string, unknown> = {}) {
    return this.post(this.route('session', 'connect', '/command'), {device_id: deviceId, target, command, arguments: args}, 'The device did not respond.');
  }

  transfer(deviceId: string, target: string, play = true) {
    return this.post(this.route('session', 'connect', '/transfer'), {device_id: deviceId, target, play}, 'Could not move playback.');
  }

  events(deviceId: string, since: number, timeout = 25) {
    return this.get<{events: ConnectEvent[]; cursor: number}>(
      this.route('session', 'connect', `/events?device=${enc(deviceId)}&since=${since}&timeout=${timeout}`),
      'Lost the connection to StarCore Connect.',
    );
  }
}

export function authHeaders(token: string | null): Record<string, string> | undefined {
  return token ? {Authorization: `Bearer ${token}`} : undefined;
}
