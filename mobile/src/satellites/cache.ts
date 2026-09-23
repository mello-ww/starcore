import AsyncStorage from '@react-native-async-storage/async-storage';
import type {SatelliteSummary} from './types';

/**
 * A per-server, on-device cache of the last satellite list StarCore
 * reported - never a global/shared cache (see "Multiple StarCore servers"
 * in the task brief: two servers can have completely different
 * satellites). Lets the Satellites screen paint immediately from the last
 * known list while the live request is in flight, and keeps showing
 * something useful if the server is temporarily unreachable - clearly
 * marked as cached by the caller (see SatellitesListScreen), never
 * presented as live data.
 */
const KEY_PREFIX = 'starcore_satellite_cache';

export async function getCachedSatellites(serverId: string): Promise<SatelliteSummary[] | null> {
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

export async function setCachedSatellites(serverId: string, satellites: SatelliteSummary[]): Promise<void> {
  await AsyncStorage.setItem(`${KEY_PREFIX}:${serverId}`, JSON.stringify(satellites));
}
