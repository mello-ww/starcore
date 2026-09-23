import AsyncStorage from '@react-native-async-storage/async-storage';
import type {ServerProfile} from '../servers/types';

/**
 * Local device storage for the StarCore servers this app knows about - a
 * list of `ServerProfile`s plus which one is active. Deliberately plain,
 * non-secret AsyncStorage, exactly like the single-server address this
 * replaced: a server's address and label are conveniences to remember, not
 * secrets to protect (that's the session token, kept separately and
 * securely - see src/auth/session.ts). Nothing here ever stores a
 * password or a session token.
 *
 * This app used to remember exactly one server address, under
 * `starcore_server_url`. `migrateLegacySingleServer()` turns that into a
 * first `ServerProfile` the first time this runs on a device that already
 * had one, so upgrading never signs an existing install out or forgets
 * its server.
 */
const SERVERS_KEY = 'starcore_servers';
const ACTIVE_SERVER_ID_KEY = 'starcore_active_server_id';
const LEGACY_SERVER_URL_KEY = 'starcore_server_url';

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function generateId(): string {
  // not a security-sensitive id (see ServerProfile's own docstring) - just
  // needs to be unique on this device
  return `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getServers(): Promise<ServerProfile[]> {
  const raw = await AsyncStorage.getItem(SERVERS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveServers(servers: ServerProfile[]): Promise<void> {
  await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
}

export async function getActiveServerId(): Promise<string | null> {
  return AsyncStorage.getItem(ACTIVE_SERVER_ID_KEY);
}

export async function setActiveServerId(id: string | null): Promise<void> {
  if (id) {
    await AsyncStorage.setItem(ACTIVE_SERVER_ID_KEY, id);
  } else {
    await AsyncStorage.removeItem(ACTIVE_SERVER_ID_KEY);
  }
}

/** Adds a server and returns it (with its generated id) - does not switch
 * the active server; callers that want that call setActiveServerId
 * themselves, so "add" and "switch to" stay two separate, explicit steps. */
export async function addServer(name: string, baseUrl: string): Promise<ServerProfile> {
  const servers = await getServers();
  const server: ServerProfile = {id: generateId(), name: name.trim() || 'StarCore', baseUrl: normalizeUrl(baseUrl)};
  await saveServers([...servers, server]);
  return server;
}

/** Removes a server's entry. Does not touch its session token or satellite
 * cache - those are namespaced by id under keys this module doesn't own
 * (see src/auth/session.ts, src/satellites/cache.ts) and are left as
 * harmless orphaned storage rather than this module reaching into theirs;
 * a removed server's id is never reused (see generateId), so they can
 * never be read back by a different server. */
export async function removeServer(id: string): Promise<void> {
  const servers = await getServers();
  await saveServers(servers.filter(server => server.id !== id));
}

/** One-time, best-effort migration from this app's previous single-server
 * storage. Safe to call on every launch: it only ever does something the
 * first time, on a device that has the legacy key and no servers list yet
 * - after that (or on a fresh install, which has neither) it's a no-op.
 * Never throws; a migration that can't complete just leaves the device to
 * start at "Connect to StarCore" like a fresh install would. */
export async function migrateLegacySingleServer(): Promise<void> {
  try {
    const [legacyUrl, servers] = await Promise.all([AsyncStorage.getItem(LEGACY_SERVER_URL_KEY), getServers()]);
    if (!legacyUrl || servers.length > 0) {
      return;
    }
    const server = await addServer('StarCore', legacyUrl);
    await setActiveServerId(server.id);
    await AsyncStorage.removeItem(LEGACY_SERVER_URL_KEY);
  } catch {
    // best-effort - see docstring
  }
}
