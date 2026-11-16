import {PermissionsAndroid} from 'react-native';

/** What asking for media access gave: `partial` is Android 14's "selected photos only";
 * `blocked` means the system no longer asks, so only its settings can grant it. */
export type AccessOutcome = 'full' | 'partial' | 'denied' | 'blocked';

type Permission = Parameters<typeof PermissionsAndroid.request>[0];

const IMAGES = 'android.permission.READ_MEDIA_IMAGES' as Permission;
const VIDEO = 'android.permission.READ_MEDIA_VIDEO' as Permission;
const SELECTED = 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED' as Permission;
const STORAGE = 'android.permission.READ_EXTERNAL_STORAGE' as Permission;
const LOCATION = 'android.permission.ACCESS_MEDIA_LOCATION' as Permission;
const NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS' as Permission;

const GRANTED = 'granted';
const BLOCKED = 'never_ask_again';

/**
 * Asks for what the backup needs, only when the person turns it on (never from the background):
 * reading images and videos (Android 13 and later) or storage (before), then the originals'
 * positions and, from Android 13, the progress notification - those two are optional.
 */
export async function requestMediaAccess(sdk: number): Promise<AccessOutcome> {
  const media = sdk >= 33 ? [IMAGES, VIDEO, ...(sdk >= 34 ? [SELECTED] : [])] : [STORAGE];
  const results = (await PermissionsAndroid.requestMultiple(media)) as Record<string, string>;
  const full = sdk >= 33 ? results[IMAGES] === GRANTED && results[VIDEO] === GRANTED : results[STORAGE] === GRANTED;
  if (!full) {
    if (sdk >= 34 && results[SELECTED] === GRANTED) {
      return 'partial';
    }
    return media.some(permission => results[permission] === BLOCKED) ? 'blocked' : 'denied';
  }
  const optional = [...(sdk >= 29 ? [LOCATION] : []), ...(sdk >= 33 ? [NOTIFICATIONS] : [])];
  if (optional.length) {
    await PermissionsAndroid.requestMultiple(optional).catch(() => undefined);
  }
  return 'full';
}
