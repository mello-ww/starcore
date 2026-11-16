import {NativeModules, Platform} from 'react-native';

/** How much of the phone's media the app may read: `partial` is Android 14's "selected photos
 * only", which is not enough for a backup. */
export type MediaAccess = 'full' | 'partial' | 'none';
export type NetworkState = 'unmetered' | 'metered' | 'none' | 'unknown';
export type SyncPhase =
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'offline'
  | 'permission'
  | 'signed-out'
  | 'unavailable'
  | 'server-full';

/** Everything the sync screen shows, as the Kotlin sync package reports it. */
export interface SyncState {
  configured: boolean;
  access: MediaAccess;
  network: NetworkState;
  plugged: boolean;
  batteryLow: boolean;
  // the rest only once this server's backup is set up
  enabled?: boolean;
  mobileData?: boolean;
  charging?: boolean;
  /** MediaStore folder ids left out; every other folder is backed up */
  excluded?: string[];
  origin?: string;
  credential?: boolean;
  phase?: SyncPhase;
  done?: number;
  total?: number;
  /** when the last run finished, epoch milliseconds (0: never) */
  lastRun?: number;
  updated?: number;
  running?: boolean;
  waiting?: boolean;
  backedUp?: number;
  pending?: number;
  failed?: number;
}

export interface SyncFolder {
  id: string;
  name: string;
  path: string;
  count: number;
}

export interface SyncFailure {
  id: string;
  name: string;
  folder: string;
  reason: string;
}

/** What the backup needs from the server: its origin, the provider and its operation routes
 * (from the catalog), and a device credential limited to the capability. */
export interface SyncSetup {
  origin: string;
  satellite: string;
  routes: {status: string; check: string; upload: string};
  device: string;
  token: string;
  sessionId: string | null;
}

export interface SyncChanges {
  enabled?: boolean;
  mobileData?: boolean;
  charging?: boolean;
  excluded?: string[];
}

export interface SyncNative {
  /** what the phone calls itself in the server's list of devices */
  deviceName: string;
  /** the Android API level */
  sdk: number;
  configure(server: string, setup: SyncSetup): Promise<SyncState>;
  update(server: string, changes: SyncChanges): Promise<SyncState>;
  state(server: string): Promise<SyncState>;
  folders(): Promise<SyncFolder[]>;
  failures(server: string): Promise<SyncFailure[]>;
  retry(server: string): Promise<SyncState>;
  runNow(server: string): Promise<SyncState>;
  /** removes everything kept for the server; resolves with the credential's session id */
  forget(server: string): Promise<string | null>;
}

/** The app's own Kotlin sync module (the background backup); absent on other platforms and
 * under Jest, where the sync screen is not offered. */
export function nativeSync(): SyncNative | null {
  const module = NativeModules.StarCoreSync;
  if (!module || Platform.OS !== 'android') {
    return null;
  }
  return {
    deviceName: typeof module.deviceName === 'string' ? module.deviceName : 'Android phone',
    sdk: typeof module.sdk === 'number' ? module.sdk : Number(Platform.Version) || 0,
    configure: (server, setup) => module.configure(server, setup),
    update: (server, changes) => module.update(server, changes),
    state: server => module.state(server),
    folders: () => module.folders(),
    failures: server => module.failures(server),
    retry: server => module.retry(server),
    runNow: server => module.runNow(server),
    forget: server => module.forget(server),
  };
}
