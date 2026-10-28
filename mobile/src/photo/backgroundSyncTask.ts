import {CameraRoll} from '@react-native-camera-roll/camera-roll';
import BackgroundFetch from 'react-native-background-fetch';
import {StarCoreClient} from '../api/client';
import {TOKEN_KEY} from '../auth/session';
import {secureStorage} from '../platform/secureStorage';
import * as store from '../storage/preferences';
import {PhotoApi} from './api';
import type {CameraAsset, CameraRollSource} from './backgroundSync';
import {syncOneServer} from './backgroundSync';
import {hasMediaLibraryPermission} from './mediaPermission';
import {getSyncState, setLastSyncedAt} from './syncState';

/** How many minutes between periodic ticks - the shortest interval
 * Android's WorkManager (what react-native-background-fetch is built on)
 * honors reliably; a fired tick can arrive later than this depending on
 * battery/Doze state, per "Periodic WorkManager" in the approved design. */
const MINIMUM_FETCH_INTERVAL_MINUTES = 15;

/** The real CameraRollSource - the only place in this file (besides the
 * secure-storage token read below) that touches an actual native module,
 * so backgroundSync.ts's own logic stays testable without one. Reads a
 * generous page size and walks pages until either everything newer than
 * `sinceMs` has been collected or the camera roll runs out, then reverses
 * the (newest-first, as CameraRoll itself pages) result so the caller
 * always sees oldest-first - see syncOneServer's own docstring on why
 * upload order has to be chronological for its cursor to make sense. */
const cameraRollSource: CameraRollSource = {
  async assetsSince(sinceMs: number): Promise<CameraAsset[]> {
    if (!(await hasMediaLibraryPermission())) {
      // never prompts from here - see mediaPermission.ts's own docstring.
      // Nothing to sync this run; the next foreground open (where the user
      // can be asked) or a later run once permission is granted picks up
      // from the same, unmoved cursor.
      return [];
    }

    const collected: CameraAsset[] = [];
    let after: string | undefined;

    for (;;) {
      const page = await CameraRoll.getPhotos({
        first: 100,
        after,
        assetType: 'All',
        include: ['filename', 'playableDuration', 'albums'],
      });

      let reachedCursor = false;
      for (const edge of page.edges) {
        const node = edge.node;
        const timestampMs = Math.round(node.timestamp * 1000);
        if (timestampMs <= sinceMs) {
          // CameraRoll pages newest-first, so once one asset is at or
          // before the cursor, everything after it on every later page is
          // too - safe to stop paging altogether
          reachedCursor = true;
          break;
        }
        const isVideo = (node.type || '').startsWith('video') || Boolean(node.image.playableDuration);
        const extension = isVideo ? 'mp4' : node.type?.includes('png') ? 'png' : 'jpg';
        // Best-effort only - the camera roll's own album/folder membership,
        // requested via `include: ['albums']` above. Different OS versions
        // and library versions have reported this as either `albums`
        // (an array of names) or the older `group_name`; either is a
        // reasonable stand-in for "phone folder" to match against Photo
        // configuration's source_paths (see uploadSync's own docstring) -
        // undefined here just means the server falls back to
        // sync_default_path, exactly as if this asset had no folder at all.
        const albums = (node as any).albums as string[] | undefined;
        const groupName = (node as any).group_name as string | undefined;
        const folder = albums && albums.length ? albums[0] : groupName || undefined;
        collected.push({
          id: node.id,
          uri: node.image.uri,
          filename: node.image.filename || `${node.id}.${extension}`,
          mimeType: node.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
          timestamp: timestampMs,
          folder,
        });
      }

      if (reachedCursor || !page.page_info.has_next_page) {
        break;
      }
      after = page.page_info.end_cursor;
    }

    // collected is newest-first (however many pages were walked) - reverse
    // once at the end so syncOneServer always uploads oldest-first
    return collected.reverse();
  },
};

async function syncServer(serverId: string, baseUrl: string): Promise<void> {
  const token = await secureStorage.getItem(`${TOKEN_KEY}:${serverId}`);
  if (!token) {
    // signed out, or the token is behind a biometric gate this headless
    // run has no way to satisfy (see secureStorage.android.ts's own
    // docstring: a gated read resolves to null rather than rejecting) -
    // this run does nothing for this server; the next foreground open or
    // periodic tick, once the app has a live token again, tries again
    return;
  }

  const client = new StarCoreClient(baseUrl, async () => token);
  await syncOneServer(serverId, cameraRollSource, new PhotoApi(client), {
    get: getSyncState,
    setLastSyncedAt,
  });
}

/** One sync pass across every server that has automatic sync turned on -
 * called by both the periodic BackgroundFetch tick and by
 * `triggerForegroundSync` (an immediate pass when the app is opened, per
 * "immediate sync also triggered on app foreground" in the approved
 * design). Never throws: one server being unreachable, or any other
 * failure, must never stop the others (multiple StarCore servers can be
 * configured on one device - see ServersContext) or crash the calling
 * BackgroundFetch task. */
export async function runBackgroundSync(): Promise<void> {
  const servers = await store.getServers();
  for (const server of servers) {
    try {
      const state = await getSyncState(server.id);
      if (!state.enabled) {
        continue;
      }
      await syncServer(server.id, server.baseUrl);
    } catch {
      // best-effort - see docstring above
    }
  }
}

/** react-native-background-fetch's headless entry point: Android can start
 * the JS engine solely to run this, with no app UI ever mounted (e.g. the
 * app was swiped away or killed by the system, or hasn't been opened since
 * a reboot) - see index.js's `BackgroundFetch.registerHeadlessTask` and
 * "enableHeadless" below. Never after an explicit "Force stop" from
 * Android's app settings: nothing runs until the user opens the app again. */
export async function backgroundFetchHeadlessTask(event: {taskId: string}): Promise<void> {
  try {
    await runBackgroundSync();
  } finally {
    BackgroundFetch.finish(event.taskId);
  }
}

/** (Re)applies the current sync settings to BackgroundFetch's own periodic
 * scheduler - called once at app start (App.tsx) and again whenever
 * PhotoSyncTab changes a setting, so a toggle takes effect on the very next
 * scheduling decision rather than waiting for the next app restart.
 *
 * BackgroundFetch has one process-wide schedule, not one per server: if
 * *any* enabled server asks for Wi-Fi-only, that constraint applies to the
 * whole periodic tick. A laxer server loses nothing important by this - it
 * only means the tick sometimes waits for Wi-Fi it didn't strictly need -
 * and `runBackgroundSync` still skips any server that isn't enabled once
 * the tick does run, so nothing is synced that shouldn't be.
 */
export async function configureBackgroundFetch(): Promise<void> {
  const servers = await store.getServers();
  const states = await Promise.all(servers.map(server => getSyncState(server.id)));
  const anyEnabled = states.some(state => state.enabled);
  const wifiOnly = states.some(state => state.enabled && state.wifiOnly);

  await BackgroundFetch.configure(
    {
      minimumFetchInterval: MINIMUM_FETCH_INTERVAL_MINUTES,
      stopOnTerminate: false,
      startOnBoot: anyEnabled,
      enableHeadless: true,
      requiredNetworkType: wifiOnly ? BackgroundFetch.NETWORK_TYPE_UNMETERED : BackgroundFetch.NETWORK_TYPE_NONE,
    },
    async taskId => {
      await runBackgroundSync();
      BackgroundFetch.finish(taskId);
    },
    async taskId => {
      // the OS ran out of patience for this run - finish immediately to
      // release the budget; syncOneServer's own cursor means whatever
      // wasn't reached yet is simply picked up by the next tick, nothing
      // already uploaded is lost or re-sent unnecessarily
      BackgroundFetch.finish(taskId);
    },
  );

  if (!anyEnabled) {
    await BackgroundFetch.stop();
  }
}

/** Called once from App.tsx on every app start so a server just opened in
 * the foreground gets caught up right away rather than waiting for the
 * next periodic tick. Fire-and-forget: no screen awaits this, since sync is
 * a background concern the UI never blocks on. */
export function triggerForegroundSync(): void {
  runBackgroundSync().catch(() => {
    // best-effort, same as the periodic path
  });
}
