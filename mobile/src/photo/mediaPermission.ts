import {PermissionsAndroid, Platform} from 'react-native';

function permissionsForThisApi(): string[] {
  const version = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  // Android 13 (API 33) split the old blanket storage permission into
  // per-media-type ones; a device on the old API level still needs the
  // original one instead (capped in AndroidManifest.xml at maxSdkVersion 32).
  if (version >= 33) {
    return [PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES, PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO];
  }
  return [PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE];
}

/** Never prompts - only reports whether the permission is already granted.
 * This is what the background/periodic sync path calls (see
 * backgroundSyncTask.ts): a headless run has no foreground Activity for
 * Android to show a permission dialog against, so it must never try to
 * request one - it just skips this run silently if permission isn't
 * already in place, exactly like a signed-out server is skipped. */
export async function hasMediaLibraryPermission(): Promise<boolean> {
  try {
    const results = await Promise.all(permissionsForThisApi().map(permission => PermissionsAndroid.check(permission)));
    return results.every(Boolean);
  } catch {
    return false;
  }
}

/** Shows the OS permission prompt if needed - only ever called from the
 * foreground (turning PhotoSyncTab's "Automatic sync" toggle on), never
 * from the background/periodic path above. */
export async function requestMediaLibraryPermission(): Promise<boolean> {
  try {
    const results = await PermissionsAndroid.requestMultiple(permissionsForThisApi());
    return Object.values(results).every(result => result === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}
