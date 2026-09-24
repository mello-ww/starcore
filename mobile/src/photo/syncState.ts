import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'starcore_photo_sync_state';

export interface PhotoSyncState {
  /** Off by default (see getSyncState) - turning a phone into a source that
   * automatically uploads everything on it is something the user opts into
   * per server, never something that starts silently the moment a server
   * is added. */
  enabled: boolean;
  /** Applies to the periodic background check (see backgroundSyncTask.ts's
   * configureBackgroundFetch) - "Wi-Fi only where Android allows it
   * reliably", per the approved design. The immediate sync triggered by
   * opening the app doesn't have an OS-level connectivity gate to enforce
   * this against (no network-info library is part of this app), so it can
   * still run on cellular; that's a disclosed, deliberate scope limit, not
   * an oversight. */
  wifiOnly: boolean;
  /** Epoch milliseconds: the newest phone asset already offered to this
   * server - see backgroundSync.ts's own docstring on why this is only ever
   * an efficiency cursor, never what makes dedup correct. */
  lastSyncedAt: number;
}

const DEFAULTS: PhotoSyncState = {enabled: false, wifiOnly: true, lastSyncedAt: 0};

/**
 * Per-server automatic-sync settings and cursor - the same on-device,
 * per-serverId AsyncStorage convention as photo/cache.ts and
 * satellites/cache.ts, for the same reason: two StarCore servers must never
 * share or collide over sync state.
 */
export async function getSyncState(serverId: string): Promise<PhotoSyncState> {
  const raw = await AsyncStorage.getItem(`${KEY_PREFIX}:${serverId}`);
  if (!raw) {
    return {...DEFAULTS};
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
      wifiOnly: typeof parsed.wifiOnly === 'boolean' ? parsed.wifiOnly : DEFAULTS.wifiOnly,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : DEFAULTS.lastSyncedAt,
    };
  } catch {
    return {...DEFAULTS};
  }
}

async function save(serverId: string, state: PhotoSyncState): Promise<void> {
  await AsyncStorage.setItem(`${KEY_PREFIX}:${serverId}`, JSON.stringify(state));
}

export async function setSyncEnabled(serverId: string, enabled: boolean): Promise<void> {
  await save(serverId, {...(await getSyncState(serverId)), enabled});
}

export async function setWifiOnly(serverId: string, wifiOnly: boolean): Promise<void> {
  await save(serverId, {...(await getSyncState(serverId)), wifiOnly});
}

/** Exported to match backgroundSync.ts's SyncStateStore shape directly -
 * backgroundSyncTask.ts passes `{get: getSyncState, setLastSyncedAt}` as
 * its store, with no adapter object needed. */
export async function setLastSyncedAt(serverId: string, timestampMs: number): Promise<void> {
  await save(serverId, {...(await getSyncState(serverId)), lastSyncedAt: timestampMs});
}
