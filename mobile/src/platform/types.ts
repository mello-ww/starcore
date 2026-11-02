/**
 * The seams between mobile-specific UI/business logic and anything that
 * only the operating system can actually do. Everything under `src/` other
 * than the concrete `*.android.ts` (and, later, `*.ios.ts`) files programs
 * against these interfaces only - never against `react-native-keychain` or
 * `react-native-biometrics` directly - so:
 *
 *   - adding iOS later means writing `secureStorage.ios.ts` /
 *     `biometrics.ios.ts` against the same two interfaces, never touching
 *     `src/auth/session.ts` or any screen;
 *   - `src/auth/session.ts` (the important, testable logic) can be unit
 *     tested with a trivial in-memory fake for each of these, with no
 *     native module and no device involved at all - see __tests__/session.test.ts.
 */

/** A small secure key/value store - Android Keystore-backed via
 * react-native-keychain (see secureStorage.android.ts), iOS Keychain-backed
 * in the future. Holds the session token per server and the biometric
 * unlock preference (see src/auth/session.ts) - never the password, which
 * this app never stores at all past the login request that sends it once
 * over the wire.
 *
 * Entries are encrypted at rest but never biometric-gated: the headless
 * background sync task (src/photo/backgroundSyncTask.ts) must read the
 * token with no UI, and every API request reads it too. Biometric unlock
 * is enforced as an app lock in front of the UI instead - see
 * src/auth/appLock.ts. */
export interface SecureStore {
  /** Stores `value` under `key`, overwriting whatever was there. */
  setItem(key: string, value: string): Promise<void>;

  /** Reads `value` back, or `null` if nothing is stored under `key` or it
   * can't be read. Never rejects. */
  getItem(key: string): Promise<string | null>;

  /** Like `getItem`, but rejects when the platform store itself can't be
   * read, so "absent" (`null`) is never confused with "unreadable". Used for
   * security preferences that must fail closed, e.g. the biometric lock. */
  getItemStrict(key: string): Promise<string | null>;

  removeItem(key: string): Promise<void>;
}

export type BiometryType = 'fingerprint' | 'face' | 'iris' | 'none';

/** Why biometrics can't be used right now: no sensor at all, a sensor but
 * nothing enrolled, or anything else (sensor temporarily unavailable, an
 * unsupported OS version, an error while checking). */
export type BiometricUnavailableReason = 'no-hardware' | 'not-enrolled' | 'unavailable';

export interface BiometricAvailability {
  available: boolean;
  biometryType: BiometryType;
  reason?: BiometricUnavailableReason;
}

/** Whether *this device* can do strong biometric authentication, and a way
 * to ask for it. Used by the biometric unlock toggle in Settings and by the
 * app lock (src/auth/appLock.ts). */
export interface BiometricAuthenticator {
  isAvailable(): Promise<BiometricAvailability>;

  /** Shows the OS's own biometric prompt. Resolves `true` only on a
   * successful match; cancellation, failure and errors all resolve `false`. */
  authenticate(promptMessage: string): Promise<boolean>;
}

/** What signing one challenge produced. "key-invalid" means the Keystore
 * key can no longer be used - most often because the enrolled fingerprints
 * or faces changed, which Android treats as invalidating it. */
export type SignResult =
  | {status: 'signed'; signature: string}
  | {status: 'cancelled'}
  | {status: 'key-invalid'};

/** A Keystore key that only signs after a strong biometric match - used
 * for the Locked Folder's biometric unlock, where the server verifies the
 * signature (see src/lockedFolder/biometricUnlock.ts). The private key
 * never leaves the device's secure hardware. One key per app install. */
export interface BiometricSigner {
  isAvailable(): Promise<BiometricAvailability>;

  keyExists(): Promise<boolean>;

  /** Creates (or replaces) the key pair; resolves its public key as base64
   * X.509 SubjectPublicKeyInfo, or null if it couldn't be created. */
  createKey(): Promise<string | null>;

  /** Shows the biometric prompt and signs `payload` with the key. */
  sign(promptMessage: string, payload: string): Promise<SignResult>;

  deleteKey(): Promise<void>;
}

/** A human-readable label for StarCore's "Active sessions" list
 * (`device_name` in `AuthStore.create_session` - see docs/api.md). Best
 * effort and never security-sensitive - worst case it's a generic label
 * the account owner can't immediately place, not a vulnerability. */
export interface DeviceInfo {
  displayName(): string;
}
