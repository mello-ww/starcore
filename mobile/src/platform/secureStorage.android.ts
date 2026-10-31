import * as Keychain from 'react-native-keychain';
import type {SecureStore} from './types';

/**
 * Android implementation of `SecureStore`, backed by the Android Keystore
 * through `react-native-keychain` - never AsyncStorage (which is plain,
 * unencrypted disk storage) and never anything StarCore writes or parses
 * itself. This is intentionally a thin adapter: all the actual security
 * work (key generation, encryption) is the Keystore's and the library's,
 * not reimplemented here.
 *
 * `react-native-keychain` stores one username/password pair per `service`
 * name, not an arbitrary map - so this uses `key` as both the `service`
 * and the stored "username", and the real value as the "password". That's
 * a standard, documented way to use it as a generic secure key/value
 * store; see https://github.com/oblador/react-native-keychain.
 *
 * No entry is ever written with a biometric `accessControl`. On Android the
 * library keys every cipher by the same Keystore alias (the service name),
 * so a biometric (RSA) write over an existing plain (AES) entry always fails
 * - and a gated token could never be read by the headless background sync
 * task anyway. See SecureStore's docstring in types.ts.
 */
class AndroidSecureStore implements SecureStore {
  async setItem(key: string, value: string): Promise<void> {
    const options = {service: key, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
    try {
      await Keychain.setGenericPassword(key, value, options);
    } catch {
      // A Keystore key left under this alias by a different cipher (e.g. a
      // biometric RSA entry from an older build) can't be reused for this
      // write. The value is being replaced anyway, so clear it and retry once.
      await Keychain.resetGenericPassword({service: key});
      await Keychain.setGenericPassword(key, value, options);
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await this.getItemStrict(key);
    } catch {
      return null;
    }
  }

  async getItemStrict(key: string): Promise<string | null> {
    const result = await Keychain.getGenericPassword({service: key});
    // getGenericPassword resolves to `false` (not a rejection) when nothing
    // is stored under this service
    return result ? result.password : null;
  }

  async removeItem(key: string): Promise<void> {
    await Keychain.resetGenericPassword({service: key});
  }
}

export const secureStorage: SecureStore = new AndroidSecureStore();
