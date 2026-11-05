import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type NetworkType = 'wifi' | 'cellular' | 'none' | 'other' | 'unknown';
export type EffectResult = {applied: boolean; reason?: string};

export interface AudioEffects {
  setEqualizer(enabled: boolean, bands: number[], preampDb: number): Promise<EffectResult>;
  setBassBoost(strength: number): Promise<EffectResult>;
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

/** The app's own Kotlin modules (android/.../music); absent on other platforms and under Jest. */
export const audioEffects: AudioEffects = {
  setEqualizer: (enabled, bands, preamp) =>
    NativeModules.StarCoreAudio?.setEqualizer(enabled, bands, preamp) ?? Promise.resolve(unsupported),
  setBassBoost: strength => NativeModules.StarCoreAudio?.setBassBoost(strength) ?? Promise.resolve(unsupported),
  setLoudness: gain => NativeModules.StarCoreAudio?.setLoudness(Math.round(gain)) ?? Promise.resolve(unsupported),
  setPlaybackParameters: (speed, semitones) =>
    NativeModules.StarCoreAudio?.setPlaybackParameters(speed, semitones) ?? Promise.resolve(unsupported),
  getNetworkType: () => NativeModules.StarCoreAudio?.getNetworkType() ?? Promise.resolve('unknown'),
};

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

/** Folder-safe server id: downloads and artwork never mix between servers. */
export function serverFolder(serverId: string): string {
  return serverId.replace(/[^A-Za-z0-9_-]/g, '_') || 'server';
}
