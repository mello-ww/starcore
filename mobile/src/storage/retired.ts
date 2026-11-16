import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Device storage that earlier versions of the app kept and that nothing reads any more: a
 * removed feature's keys, one entry per prefix (the key itself, or the key followed by `:` and a
 * server id). Removing them is all that is left of that feature on the phone.
 */
export const RETIRED_PREFIXES = [
  // the background upload of the camera roll's state, per server (removed before its new form)
  'starcore_photo_sync_state',
];

let purged = false;

/** Removes every retired key, once per run; a failure is tried again by the next call. */
export async function purgeRetiredKeys(): Promise<void> {
  if (purged) {
    return;
  }
  try {
    const retired = (await AsyncStorage.getAllKeys()).filter(key =>
      RETIRED_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}:`)),
    );
    if (retired.length) {
      await AsyncStorage.multiRemove(retired);
    }
    purged = true;
  } catch {
    // storage unavailable: tried again by the next call
  }
}

/** For tests: forgets that this run already purged. */
export function resetRetiredPurgeForTests(): void {
  purged = false;
}
