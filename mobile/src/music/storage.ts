import AsyncStorage from '@react-native-async-storage/async-storage';
import type {RepeatMode, Track} from './types';

/** Every key carries the server id: queues, devices and downloads never cross servers. */
export const musicKeys = {
  queue: (serverId: string) => `starcore_music_queue:${serverId}`,
  device: (serverId: string) => `starcore_music_device:${serverId}`,
  downloads: (serverId: string) => `starcore_music_downloads:${serverId}`,
};

export interface SavedQueue {
  tracks: Track[];
  order: number[];
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;
  seconds: number;
  context: string | null;
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // a full disk only costs the saved queue
  }
}

export async function deviceId(serverId: string, random: () => number = Math.random): Promise<string> {
  const key = musicKeys.device(serverId);
  const existing = await AsyncStorage.getItem(key);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) {
    return existing;
  }
  const generated = `mobile-${Date.now().toString(36)}-${Math.floor(random() * 1e10).toString(36)}`;
  await AsyncStorage.setItem(key, generated);
  return generated;
}
