import * as Keychain from 'react-native-keychain';
import type {SecureStore} from './types';

/**
 * Android implementation of `SecureStore`, backed by the Android Keystore
 * through `react-native-keychain` - never AsyncStorage (which is plain,
 * unencrypted disk storage) and never anything StarCore writes or parses
 * itself. This is intentionally a thin adapter: all the actual security
 * work (key generation, encryption, the biometric prompt itself) is the
 * Keystore's and the library's, not reimplemented here.
 *
 * `react-native-keychain` stores one username/password pair per `service`
 * name, not an arbitrary map - so this uses `key` as both the `service`
 * and the stored "username", and the real value as the "password". That's
 * a standard, documented way to use it as a generic secure key/value
 * store; see https://github.com/oblador/react-native-keychain.
 */
class AndroidSecureStore implements SecureStore {
  async setItem(key: string, value: string, options?: {requireAuthentication?: boolean}): Promise<void> {
    await Keychain.setGenericPassword(key, value, {
      service: key,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      ...(options?.requireAuthentication
        ? {accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET}
        : {}),
    });
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const result = await Keychain.getGenericPassword({service: key});
      // getGenericPassword resolves to `false` (not a rejection) both when
      // nothing is stored and when a biometric-gated read was cancelled or
      // failed - both cases mean "nothing to release right now" to every
      // caller in this app (see SecureStore.getItem's own docstring).
      return result ? result.password : null;
    } catch {
      return null;
    }
  }

  async removeItem(key: string): Promise<void> {
    await Keychain.resetGenericPassword({service: key});
  }
}

export const secureStorage: SecureStore = new AndroidSecureStore();
