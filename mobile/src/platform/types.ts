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
 * in the future. Holds exactly one thing StarCore actually needs kept
 * secret: the session token (see src/auth/session.ts) - never the
 * password, which this app never stores at all past the login request
 * that sends it once over the wire. */
export interface SecureStore {
  /** Stores `value` under `key`. `requireAuthentication: true` asks the
   * platform to gate this specific entry behind the device's biometric
   * (or PIN/pattern fallback) unlock - see "Biometric unlock" in
   * README.md. Overwrites whatever was there, including its previous
   * `requireAuthentication` setting. */
  setItem(key: string, value: string, options?: {requireAuthentication?: boolean}): Promise<void>;

  /** Reads `value` back, or `null` if nothing is stored under `key`. If the
   * entry was stored with `requireAuthentication: true`, the platform
   * itself prompts for biometrics before this resolves - StarCore never
   * sees the value at all unless that check passes, and never implements
   * its own "was biometrics ok?" flag to bypass. Resolves to `null`
   * (never rejects) if the user cancels or fails that prompt, so callers
   * can treat "declined" and "not present" the same way: fall back to a
   * normal login. */
  getItem(key: string): Promise<string | null>;

  removeItem(key: string): Promise<void>;
}

export type BiometryType = 'fingerprint' | 'face' | 'iris' | 'none';

/** Whether *this device* can do biometric authentication at all, and a way
 * to ask for it directly (used only to show/confirm the "Enable biometric
 * unlock" toggle - the actual gate that protects the session token is
 * `SecureStore`'s `requireAuthentication`, not this). */
export interface BiometricAuthenticator {
  isAvailable(): Promise<{available: boolean; biometryType: BiometryType}>;

  /** Shows the OS's own biometric prompt once, for its own sake (e.g. when
   * the user first turns the "Enable biometric unlock" toggle on) - not
   * something session restore needs to call itself, since SecureStore's
   * `requireAuthentication` entries prompt on their own when read. */
  authenticate(promptMessage: string): Promise<boolean>;
}

/** A human-readable label for StarCore's "Active sessions" list
 * (`device_name` in `AuthStore.create_session` - see docs/api.md). Best
 * effort and never security-sensitive - worst case it's a generic label
 * the account owner can't immediately place, not a vulnerability. */
export interface DeviceInfo {
  displayName(): string;
}
