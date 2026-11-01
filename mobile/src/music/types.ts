export type Quality = 'original' | 'high' | 'normal' | 'low';
export type RepeatMode = 'off' | 'all' | 'one';

export interface ArtistRef {
  id: string;
  name: string;
}

export interface TrackQuality {
  lossless: boolean;
  hires: boolean;
  label: string;
  tier: number;
}

export interface Track {
  id: string;
  title: string;
  artist: string | null;
  artists: ArtistRef[];
  artist_id: string;
  album: string | null;
  album_id: string;
  album_artist: string;
  album_artist_id: string;
  track: number | null;
  disc: number | null;
  year: number | null;
  date?: string | null;
  genre: string | null;
  duration: number | null;
  format: string;
  codec: string | null;
  bitrate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  quality: TrackQuality;
  size: number;
  filename?: string;
  has_artwork: boolean;
  has_lyrics: boolean;
  replaygain?: {track_gain: number | null; album_gain: number | null; track_peak: number | null; album_peak: number | null};
  credits?: {composer: string | null; producer: string | null; label: string | null; copyright: string | null; isrc: string | null};
  missing?: boolean;
  liked?: boolean;
  reason?: string | null;
  entry_id?: string | null;
  plays?: number;
}

export interface Album {
  id: string;
  album: string;
  artist: string;
  artist_id: string;
  year: number | null;
  tracks: number | Track[];
  duration: number;
  type: 'album' | 'single' | 'ep' | 'compilation';
  artwork: string | null;
  quality: TrackQuality;
  label?: string | null;
  liked?: boolean;
  credits?: Record<string, string[]>;
  more_by_artist?: Album[];
}

export interface AlbumDetail extends Omit<Album, 'tracks'> {
  tracks: Track[];
}

export interface Artist {
  id: string;
  name: string;
  albums: number;
  tracks: number;
  artwork: string | null;
}

export interface ArtistDetail {
  id: string;
  name: string;
  albums: Album[];
  singles: Album[];
  appears_on: Album[];
  top_tracks: Track[];
  genres: string[];
  artwork: string | null;
  similar: {id: string; name: string; reason: string}[];
  followed: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  folder: string;
  smart: boolean;
  pinned: boolean;
  tracks: number | Track[];
  duration: number;
  mosaic: string[];
  cover: string | null;
  track_count?: number;
  unavailable?: number;
}

export interface PlaylistDetail extends Omit<Playlist, 'tracks'> {
  tracks: Track[];
}

export interface Mix {
  id: string;
  name: string;
  description?: string;
  kind: string;
  tracks: number | Track[];
  mosaic?: string[];
}

export interface HomeSection {
  id: string;
  title: string;
  subtitle?: string | null;
  kind: 'tracks' | 'albums' | 'artists' | 'mixes' | 'contexts' | 'moods';
  items: any[];
}

export interface HomePayload {
  greeting: string;
  sections: HomeSection[];
  personalized: boolean;
}

export interface SearchResult {
  query: string;
  top: {kind: 'track' | 'album' | 'artist'; item: any} | null;
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  genres: {name: string; tracks: number}[];
  corrected: string | null;
}

export interface LyricLine {
  time: number;
  text: string;
  words: {time: number; text: string}[];
  translation: string | null;
}

export interface Lyrics {
  synced: boolean;
  karaoke: boolean;
  lines: LyricLine[];
  plain: string;
  source: string;
  language: string | null;
  languages: string[];
  offset: number;
}

export interface Equalizer {
  enabled: boolean;
  preset: string;
  bands: number[];
  preamp: number;
}

export interface MusicPreferences {
  streaming_quality: Quality;
  cellular_quality: Quality;
  download_quality: Quality;
  transcode_format: 'opus' | 'aac' | 'mp3';
  replaygain: 'off' | 'track' | 'album';
  normalize: boolean;
  crossfade: number;
  equalizer: Equalizer;
  bass_boost: number;
  speed: number;
  pitch: number;
  preserve_pitch: boolean;
  lyrics_offset: number;
  history_enabled: boolean;
  discovery_enabled: boolean;
  queue_end: 'stop' | 'repeat' | 'autoplay';
  download_network: 'wifi' | 'any';
  cache_limit_mb: number;
  [key: string]: any;
}

export interface PlaybackPlan {
  delivery: 'original' | 'transcode';
  format: string;
  codec: string | null;
  bitrate: number | null;
  lossless: boolean;
  reason: string | null;
}

export interface PlaybackInfo {
  track: Track;
  plan: PlaybackPlan;
  stream: string;
  gain: {db: number; source: string | null; peak: number | null};
  normalize: boolean;
}

export interface ConnectDevice {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  playing: boolean;
  track_id: string | null;
  volume: number | null;
}

export interface QueueState {
  queue: string[];
  index: number;
  order: number[] | null;
  position: number;
  duration?: number;
  playing: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  speed: number;
  context: string | null;
  updated_at?: number;
}

export interface ConnectEvent {
  type: 'command' | 'state' | 'devices';
  seq: number;
  id?: string;
  target?: string;
  from?: string | null;
  device?: string;
  command?: string;
  arguments?: any;
  state?: any;
}
