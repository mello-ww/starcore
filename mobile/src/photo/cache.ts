import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Photo} from './types';

/**
 * A per-server, on-device cache of the last photo list StarCore reported -
 * the same convention as src/satellites/cache.ts, for the same reason: two
 * StarCore servers can have completely different libraries, so this is
 * namespaced by `serverId` and never shared or merged across servers.
 * Switching servers must never show one server's cached photos while
 * pointed at another - see "Offline and server switching" in the task
 * brief - so every read/write here always goes through a serverId.
 *
 * This holds photo metadata only (the same JSON the `photos` route
 * returns) - never image bytes. Thumbnails themselves are cached by the
 * platform's own Image loader, which already keeps a disk cache keyed by
 * URL (and therefore, incidentally, by server, since the URL includes the
 * server's own base address).
 */
const KEY_PREFIX = 'starcore_photo_cache';

export async function getCachedPhotos(serverId: string): Promise<Photo[] | null> {
  const raw = await AsyncStorage.getItem(`${KEY_PREFIX}:${serverId}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function setCachedPhotos(serverId: string, photos: Photo[]): Promise<void> {
  await AsyncStorage.setItem(`${KEY_PREFIX}:${serverId}`, JSON.stringify(photos));
}

/** Drops one photo from the cached list straight away - used when it moves
 * into the Locked Folder, so its name and details don't linger on the phone
 * until the next refresh. */
export async function forgetCachedPhoto(serverId: string, photoId: string): Promise<void> {
  const cached = await getCachedPhotos(serverId);
  if (cached && cached.some(photo => photo.id === photoId)) {
    await setCachedPhotos(serverId, cached.filter(photo => photo.id !== photoId));
  }
}
