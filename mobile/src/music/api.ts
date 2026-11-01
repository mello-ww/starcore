import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import type {
  AlbumDetail,
  Album,
  Artist,
  ArtistDetail,
  ConnectDevice,
  ConnectEvent,
  HomePayload,
  Lyrics,
  Mix,
  MusicPreferences,
  PlaybackInfo,
  Playlist,
  PlaylistDetail,
  Quality,
  QueueState,
  SearchResult,
  Track,
} from './types';

export const MUSIC_BASE = '/api/satellites/music';

const enc = encodeURIComponent;

/** The Music satellite's REST API (docs/satellites/music.md); the only place screens reach it. */
export class MusicApi {
  constructor(private client: StarCoreClient) {}

  private async get<T>(path: string, fallback: string): Promise<T> {
    const {status, body} = await this.client.get(`${MUSIC_BASE}/${path}`);
    if (status !== 200) {
      throw new ApiError(body?.error || fallback, status);
    }
    return body as T;
  }

  private async post<T>(path: string, payload: unknown, fallback: string): Promise<T> {
    const {status, body} = await this.client.post(`${MUSIC_BASE}/${path}`, payload ?? {});
    if (status !== 200 && status !== 201) {
      throw new ApiError(body?.error || fallback, status);
    }
    return body as T;
  }

  summary() {
    return this.get<any>('library', 'Could not load the music library.');
  }

  home(hour: number) {
    return this.get<HomePayload>(`home?hour=${hour}`, 'Could not load Home.');
  }

  search(query: string, filters: {genre?: string; quality?: string} = {}) {
    const extra = (filters.genre ? `&genre=${enc(filters.genre)}` : '') + (filters.quality ? `&quality=${filters.quality}` : '');
    return this.get<SearchResult>(`search?q=${enc(query)}${extra}`, 'Search failed.');
  }

  async suggest(query: string) {
    return (await this.get<{suggestions: any[]}>(`search/suggest?q=${enc(query)}`, 'Search failed.')).suggestions;
  }

  async recentSearches() {
    return (await this.get<{recent: string[]}>('search/recent', 'Could not load recent searches.')).recent;
  }

  rememberSearch(query: string) {
    return this.post('search/recent', {query}, 'Could not save the search.');
  }

  clearSearches() {
    return this.post('search/recent', {clear: true}, 'Could not clear searches.');
  }

  async tracks(params = '') {
    return (await this.get<{tracks: Track[]}>(`tracks${params}`, 'Could not load tracks.')).tracks;
  }

  track(id: string) {
    return this.get<Track>(`tracks/${enc(id)}`, 'Could not load this track.');
  }

  async albums(sort = 'title') {
    return (await this.get<{albums: Album[]}>(`albums?sort=${sort}`, 'Could not load albums.')).albums;
  }

  album(id: string) {
    return this.get<AlbumDetail>(`albums/${enc(id)}`, 'Could not load this album.');
  }

  async artists() {
    return (await this.get<{artists: Artist[]}>('artists', 'Could not load artists.')).artists;
  }

  artist(id: string) {
    return this.get<ArtistDetail>(`artists/${enc(id)}`, 'Could not load this artist.');
  }

  favorites() {
    return this.get<{tracks: Track[]; albums: Album[]; artists: Artist[]; ids: Record<string, string[]>}>(
      'favorites',
      'Could not load your likes.',
    );
  }

  setFavorite(kind: 'track' | 'album' | 'artist' | 'playlist', ids: string[], liked: boolean) {
    return this.post<{ids: Record<string, string[]>}>('favorites', {kind, ids, liked}, 'Could not update your likes.');
  }

  async playlists() {
    return (await this.get<{playlists: Playlist[]}>('playlists', 'Could not load playlists.')).playlists;
  }

  playlist(id: string) {
    return this.get<PlaylistDetail>(`playlists/${enc(id)}`, 'Could not load this playlist.');
  }

  createPlaylist(name: string, tracks: string[] = [], description = '') {
    return this.post<PlaylistDetail>('playlists', {name, tracks, description}, 'Could not create the playlist.');
  }

  updatePlaylist(id: string, changes: {name?: string; description?: string}) {
    return this.post<PlaylistDetail>(`playlists/${enc(id)}`, changes, 'Could not update the playlist.');
  }

  deletePlaylist(id: string) {
    return this.post(`playlists/${enc(id)}/delete`, {}, 'Could not delete the playlist.');
  }

  addToPlaylist(id: string, tracks: string[]) {
    return this.post<{added: number; duplicates: string[]; playlist: PlaylistDetail}>(
      `playlists/${enc(id)}/add`,
      {tracks},
      'Could not add to the playlist.',
    );
  }

  removeFromPlaylist(id: string, entries: string[]) {
    return this.post<PlaylistDetail>(`playlists/${enc(id)}/remove`, {entries}, 'Could not remove from the playlist.');
  }

  moveInPlaylist(id: string, entry: string, to: number) {
    return this.post<PlaylistDetail>(`playlists/${enc(id)}/move`, {entry, to}, 'Could not reorder the playlist.');
  }

  history(limit = 50) {
    return this.get<{tracks: Track[]}>(`history?limit=${limit}`, 'Could not load your history.');
  }

  recordPlay(trackId: string, seconds: number, device: string, context: string | null) {
    return this.post('history', {track_id: trackId, seconds, device, context}, 'Could not record the play.');
  }

  clearHistory() {
    return this.post('history/clear', {}, 'Could not clear your history.');
  }

  mix(id: string) {
    return this.get<Mix & {tracks: Track[]}>(`mixes/${enc(id)}`, 'Could not load this mix.');
  }

  radio(kind: 'track' | 'artist' | 'album' | 'genre', id: string) {
    return this.get<Mix & {tracks: Track[]}>(`radio/${kind}/${enc(id)}`, 'Could not start the radio.');
  }

  mood(id: string) {
    return this.get<{name: string; tracks: Track[]}>(`moods/${enc(id)}`, 'Could not load this mood.');
  }

  lyrics(trackId: string, language?: string) {
    return this.get<Lyrics>(`lyrics/${enc(trackId)}${language ? `?language=${enc(language)}` : ''}`, 'No lyrics.');
  }

  setLyricsOffset(trackId: string, offset: number) {
    return this.post(`lyrics/${enc(trackId)}`, {offset}, 'Could not save the offset.');
  }

  preferences() {
    return this.get<MusicPreferences>('preferences', 'Could not load music settings.');
  }

  updatePreferences(changes: Partial<MusicPreferences>) {
    return this.post<MusicPreferences>('preferences', changes, 'Could not save music settings.');
  }

  playback(trackId: string, quality: Quality) {
    return this.get<PlaybackInfo>(`playback/${enc(trackId)}?quality=${quality}`, 'Could not prepare playback.');
  }

  async savedQueue(device: string) {
    return (await this.get<{state: (QueueState & {tracks?: Track[]}) | null}>(
      `queue?device=${enc(device)}&expand=1`,
      'Could not load the queue.',
    )).state;
  }

  saveQueue(device: string, state: QueueState, name: string) {
    return this.post('queue', {device, state, name, kind: 'mobile'}, 'Could not save the queue.');
  }

  registerDevice(deviceId: string, name: string) {
    return this.post<{cursor: number}>(
      'connect/register',
      {device_id: deviceId, name, kind: 'mobile', capabilities: {play: true, remote: true, volume: true, offline: true}},
      'Could not register this device.',
    );
  }

  devices() {
    return this.get<{devices: ConnectDevice[]; active: {device: string; state: QueueState} | null}>(
      'connect/devices',
      'Could not load devices.',
    );
  }

  publishState(deviceId: string, state: QueueState) {
    return this.post('connect/state', {device_id: deviceId, state}, 'Could not publish playback state.');
  }

  command(deviceId: string, target: string, command: string, args: Record<string, unknown> = {}) {
    return this.post('connect/command', {device_id: deviceId, target, command, arguments: args}, 'The device did not respond.');
  }

  transfer(deviceId: string, target: string, play = true) {
    return this.post('connect/transfer', {device_id: deviceId, target, play}, 'Could not move playback.');
  }

  events(deviceId: string, since: number, timeout = 25) {
    return this.get<{events: ConnectEvent[]; cursor: number}>(
      `connect/events?device=${enc(deviceId)}&since=${since}&timeout=${timeout}`,
      'Lost the connection to StarCore Connect.',
    );
  }
}

export function musicUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${MUSIC_BASE}/${path}`;
}

export function authHeaders(token: string | null): Record<string, string> | undefined {
  return token ? {Authorization: `Bearer ${token}`} : undefined;
}

export function artworkSource(baseUrl: string, token: string | null, albumId: string | null | undefined, size = 300) {
  if (!albumId) {
    return null;
  }
  return {uri: musicUrl(baseUrl, `artwork/${enc(albumId)}?size=${size}`), headers: authHeaders(token)};
}

export function streamPath(trackId: string, quality: Quality, format: string): string {
  return quality === 'original'
    ? `stream/${enc(trackId)}?quality=original`
    : `stream/${enc(trackId)}?quality=${quality}&format=${format}`;
}
