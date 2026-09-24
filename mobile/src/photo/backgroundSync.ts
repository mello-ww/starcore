import type {Photo} from './types';

/** One phone photo or video, as far as sync needs to know about it - a
 * narrowed view of what @react-native-camera-roll/camera-roll's own node
 * shape carries, so this module (and its tests) never depend on that
 * library's actual types. */
export interface CameraAsset {
  /** The camera roll's own asset id - not sent to the server, only useful
   * for debugging/logging on this side. */
  id: string;
  /** A local content:// or file:// URI - handed straight to
   * StarCoreClient.postFile, never read into JS memory here. */
  uri: string;
  filename: string;
  mimeType: string;
  /** Epoch milliseconds this asset was created on the phone. */
  timestamp: number;
}

/** What backgroundSync.ts needs from the camera roll - narrowed to exactly
 * this module's own use, so it can be unit tested with a plain in-memory
 * fake instead of the native module (see __tests__/backgroundSync.test.ts),
 * the same pattern SecureStore/BiometricAuthenticator use in session.ts. */
export interface CameraRollSource {
  /** Every photo/video created strictly after `sinceMs`, oldest first. */
  assetsSince(sinceMs: number): Promise<CameraAsset[]>;
}

export interface SyncStateStore {
  get(serverId: string): Promise<{enabled: boolean; lastSyncedAt: number}>;
  setLastSyncedAt(serverId: string, timestampMs: number): Promise<void>;
}

export interface SyncUploader {
  uploadSync(file: {uri: string; name: string; type: string}): Promise<{status: 'imported' | 'duplicate'; photo: Photo | null}>;
}

export interface SyncOutcome {
  /** How many candidate assets the camera roll reported since the cursor -
   * not the same as uploaded+duplicates+failed, since a failure stops the
   * batch (see below) and leaves anything chronologically after it unread. */
  scanned: number;
  uploaded: number;
  duplicates: number;
  failed: number;
}

/**
 * The actual "look for new phone media and send it" logic for one server -
 * framework- and native-module-free so it can be unit tested with fakes for
 * the camera roll, the uploader and the state store, the same pattern
 * session.ts already uses for SecureStore/BiometricAuthenticator. The real
 * wiring (the actual CameraRoll/PhotoApi/AsyncStorage) lives in
 * backgroundSyncTask.ts, which is the only thing react-native-background-
 * fetch and App.tsx ever call directly.
 *
 * Never deletes anything from the camera roll - this only ever reads it and
 * sends copies onward, exactly like the manual sync.py upload page and every
 * other flow in this app. See "Real automatic phone sync" in
 * docs/satellites/photo.md.
 *
 * Dedup is primarily the server's own content-hash dedup (library.add_file
 * - the same one manual imports and the legacy sync.py listener already
 * rely on): re-uploading something StarCore already has is harmless (a
 * "duplicate" response, nothing double-stored), so the cursor this function
 * advances is only ever a local efficiency optimization ("don't bother
 * re-scanning/re-sending what's surely already been offered"), never a
 * source of correctness by itself.
 *
 * The cursor is a single timestamp watermark, so it can only ever advance
 * past assets that were handled *in order* - if uploading one asset fails
 * (network error, server unreachable, an unsupported file), the batch stops
 * there rather than skipping ahead: the cursor is left exactly at the last
 * success, so the failed asset (and everything chronologically after it,
 * whether or not this run got to look at it yet) is retried on the next
 * run - periodic or triggered by opening the app - rather than being
 * silently skipped over.
 */
export async function syncOneServer(
  serverId: string,
  camera: CameraRollSource,
  uploader: SyncUploader,
  state: SyncStateStore,
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {scanned: 0, uploaded: 0, duplicates: 0, failed: 0};
  const current = await state.get(serverId);
  if (!current.enabled) {
    return outcome;
  }

  const assets = await camera.assetsSince(current.lastSyncedAt);
  outcome.scanned = assets.length;

  for (const asset of assets) {
    try {
      const result = await uploader.uploadSync({uri: asset.uri, name: asset.filename, type: asset.mimeType});
      if (result.status === 'duplicate') {
        outcome.duplicates += 1;
      } else {
        outcome.uploaded += 1;
      }
      await state.setLastSyncedAt(serverId, asset.timestamp);
    } catch {
      outcome.failed += 1;
      break; // see the watermark note above - stop rather than let the
      // cursor skip past this asset
    }
  }

  return outcome;
}
