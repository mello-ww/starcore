import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type NetworkType = 'wifi' | 'cellular' | 'none' | 'other' | 'unknown';
export type EffectResult = {applied: boolean; reason?: string};

export interface AudioEffects {
  setEqualizer(enabled: boolean, bands: number[], preampDb: number): Promise<EffectResult>;
  setBassBoost(strength: number): Promise<EffectResult>;
  /** Evens out loud and quiet passages, as Mission Control's compressor does (normalize). */
  setNormalize(enabled: boolean): Promise<EffectResult>;
  setLoudness(gainMillibels: number): Promise<EffectResult>;
  setPlaybackParameters(speed: number, semitones: number): Promise<EffectResult>;
  getNetworkType(): Promise<NetworkType>;
}

export interface DownloadNative {
  download(id: string, url: string, headers: Record<string, string>, relative: string): Promise<{path: string; size: number}>;
  cancel(id: string): Promise<boolean>;
  remove(relative: string): Promise<boolean>;
  exists(relative: string): Promise<string | null>;
  usage(relative: string): Promise<{used: number; free: number}>;
  onProgress(listener: (event: {id: string; received: number; total: number}) => void): () => void;
}

const unsupported: EffectResult = {applied: false, reason: 'unsupported'};

/** The app's own Kotlin audio and downloads modules; absent on other platforms and under Jest. */
export const audioEffects: AudioEffects = {
  setEqualizer: (enabled, bands, preamp) =>
    NativeModules.StarCoreAudio?.setEqualizer(enabled, bands, preamp) ?? Promise.resolve(unsupported),
  setBassBoost: strength => NativeModules.StarCoreAudio?.setBassBoost(strength) ?? Promise.resolve(unsupported),
  setNormalize: enabled => NativeModules.StarCoreAudio?.setNormalize(enabled) ?? Promise.resolve(unsupported),
  setLoudness: gain => NativeModules.StarCoreAudio?.setLoudness(Math.round(gain)) ?? Promise.resolve(unsupported),
  setPlaybackParameters: (speed, semitones) =>
    NativeModules.StarCoreAudio?.setPlaybackParameters(speed, semitones) ?? Promise.resolve(unsupported),
  getNetworkType: () => NativeModules.StarCoreAudio?.getNetworkType() ?? Promise.resolve('unknown'),
};

/**
 * The most telling colour of a cover, as #rrggbb, sampled small by the app's audio module with
 * Mission Control's rule (media/theme.js): the most saturated bucket, lifted so dark ink reads on
 * it. Null where it can't be read (no module, no picture, offline).
 */
export function artworkColour(url: string, headers?: Record<string, string>): Promise<string | null> {
  const module = NativeModules.StarCoreAudio;
  if (!module?.artworkColour) {
    return Promise.resolve(null);
  }
  return Promise.resolve(module.artworkColour(url, headers ?? {})).then(
    (value: unknown) => (typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value) ? value : null),
    () => null,
  );
}

export function nativeDownloads(): DownloadNative | null {
  const module = NativeModules.StarCoreDownloads;
  if (!module || Platform.OS !== 'android') {
    return null;
  }
  const emitter = new NativeEventEmitter(module);
  return {
    download: (id, url, headers, relative) => module.download(id, url, headers, relative),
    cancel: id => module.cancel(id),
    remove: relative => module.remove(relative),
    exists: relative => module.exists(relative),
    usage: relative => module.usage(relative),
    onProgress: listener => {
      const subscription = emitter.addListener('StarCoreDownloadProgress', listener);
      return () => subscription.remove();
    },
  };
}

export interface Timers {
  setTimer(callback: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

interface TimerNative {
  start(id: number, ms: number): Promise<boolean>;
  cancel(id: number): void;
}

/**
 * Timers that keep running while the app is in the background: React Native suspends its own
 * while the activity is paused, a locked screen included. Null where the native module is absent
 * (other platforms, Jest), so callers keep setTimeout there.
 */
export function backgroundTimers(module: TimerNative | undefined = NativeModules.StarCoreTimer): Timers | null {
  if (!module) {
    return null;
  }
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer(callback, ms) {
      const id = next++;
      live.set(id, callback);
      module.start(id, Math.max(0, ms)).then(
        fired => {
          const run = live.get(id);
          if (fired && run) {
            live.delete(id);
            run();
          }
        },
        () => live.delete(id),
      );
      return id;
    },
    clearTimer(handle) {
      if (live.delete(handle)) {
        module.cancel(handle);
      }
    },
  };
}

/** Folder-safe server id: downloads and artwork never mix between servers. */
export function serverFolder(serverId: string): string {
  return serverId.replace(/[^A-Za-z0-9_-]/g, '_') || 'server';
}
