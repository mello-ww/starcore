import type {MusicPreferences, Track} from '../src/music/types';

export function makeTrack(index: number, prefix = 'a'): Track {
  const id = `${prefix.charCodeAt(0).toString(16)}${String(index).padStart(14, '0')}`;
  return {
    id,
    title: `Song ${prefix}${index}`,
    artist: 'Artist',
    artists: [{id: 'ar01ar01ar01ar01', name: 'Artist'}],
    artist_id: 'ar01ar01ar01ar01',
    album: 'Album',
    album_id: 'ab01ab01ab01ab01',
    album_artist: 'Artist',
    album_artist_id: 'ar01ar01ar01ar01',
    track: index,
    disc: 1,
    year: 2020,
    genre: 'Rock',
    duration: 200,
    format: 'flac',
    codec: 'flac',
    bitrate: 900000,
    sample_rate: 44100,
    bit_depth: 16,
    channels: 2,
    quality: {lossless: true, hires: false, label: 'Lossless 16-bit/44.1 kHz', tier: 2},
    size: 10_000_000,
    has_artwork: true,
    has_lyrics: false,
    replaygain: {track_gain: -6, album_gain: -4, track_peak: 0.9, album_peak: 0.95},
  };
}

export function makeTracks(count: number, prefix = 'a'): Track[] {
  return Array.from({length: count}, (_, index) => makeTrack(index, prefix));
}

export const preferences: MusicPreferences = {
  streaming_quality: 'original',
  cellular_quality: 'normal',
  download_quality: 'original',
  transcode_format: 'opus',
  replaygain: 'album',
  normalize: false,
  crossfade: 0,
  equalizer: {enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0},
  bass_boost: 0,
  speed: 1,
  pitch: 0,
  preserve_pitch: true,
  lyrics_offset: 0,
  history_enabled: true,
  discovery_enabled: true,
  queue_end: 'stop',
  download_network: 'wifi',
  cache_limit_mb: 2048,
};

export function fakeEffects() {
  const applied = {applied: true};
  return {
    setEqualizer: jest.fn(async () => applied),
    setBassBoost: jest.fn(async () => applied),
    setLoudness: jest.fn(async () => applied),
    setPlaybackParameters: jest.fn(async () => applied),
    getNetworkType: jest.fn(async () => 'wifi' as const),
  };
}

/** Timers the test fires by hand. */
export function manualTimers() {
  let next = 1;
  const pending = new Map<number, {callback: () => void; ms: number}>();
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, {callback, ms});
      return id;
    },
    clearTimer: (id: number) => pending.delete(id),
    async runAll(filter: (ms: number) => boolean = () => true) {
      for (const [id, timer] of [...pending.entries()]) {
        if (filter(timer.ms)) {
          pending.delete(id);
          await timer.callback();
        }
      }
    },
    pending,
  };
}
