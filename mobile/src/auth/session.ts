import type {AuthApiClient} from '../api/auth';
import type {BiometricAuthenticator, BiometricAvailability, DeviceInfo, SecureStore} from '../platform/types';

/** Exported so App.tsx/AuthContext can wire `StarCoreClient`'s token
 * provider to read from the exact same SecureStore entry `SessionManager`
 * writes to, without a second, independent notion of "where is the token"
 * existing anywhere in the app. This is the *default* key, used as-is by
 * anything that only ever talks to one server; multi-server support
 * (AuthContext) instead passes SessionManager a key namespaced with the
 * server's own id, so two servers' sessions on the same device can never
 * collide or be read as each other's. */
export const TOKEN_KEY = 'starcore_session_token';
export const BIOMETRIC_ENABLED_KEY = 'starcore_biometric_unlock_enabled';

export interface Session {
  token: string;
}

/** Outcome of turning biometric unlock on or off. Only `'enabled'` /
 * `'disabled'` change anything; `'cancelled'` is not an error. */
export type BiometricToggleResult = 'cancelled' | 'not-enrolled' | 'unavailable' | 'failed';
export type BiometricEnableResult = 'enabled' | BiometricToggleResult;
export type BiometricDisableResult = 'disabled' | BiometricToggleResult;

/**
 * Owns the session token's entire lifecycle on this device: obtaining one
 * from StarCore, storing it securely, restoring it on a later launch, and
 * clearing it on logout. This is the one place that decides "is the user
 * signed in" - screens and navigation only ever ask *this*, never read
 * `SecureStore` or the API directly themselves.
 *
 * Deliberately framework-free (no React here) so it can be unit tested
 * with plain fakes for `AuthApi`/`SecureStore`/`BiometricAuthenticator` -
 * see __tests__/session.test.ts - and so the same class works unmodified
 * from a future iOS build, which needs identical session logic behind
 * different platform implementations of those two interfaces.
 *
 * Security posture: presence of a locally-stored token is *never* treated
 * as proof of being logged in by itself. `restore()` always re-validates
 * the token against the live server (`AuthApi.status()`) before reporting
 * a session as good - StarCore's server remains the sole authority on
 * whether a session is actually valid, exactly as it is for Mission
 * Control. A stored token that the server no longer accepts (expired,
 * revoked from another device, ...) is treated as "not logged in" and
 * removed from storage, not silently kept around for a retry.
 */
export class SessionManager {
  constructor(
    private api: AuthApiClient,
    private secureStore: SecureStore,
    private biometrics: BiometricAuthenticator,
    private deviceInfo: DeviceInfo,
    /** Which SecureStore entry holds this manager's token - defaults to
     * the plain, single-server key so every existing caller/test is
     * unaffected. Multi-server support (AuthContext) passes one
     * namespaced with the active server's id instead, so switching
     * servers can never read or clear another server's session. */
    private tokenKey: string = TOKEN_KEY,
    private biometricEnabledKey: string = BIOMETRIC_ENABLED_KEY,
  ) {}

  /** Called once at app start. Never throws - a network error or missing
   * token both simply mean "start at the login screen". */
  async restore(): Promise<Session | null> {
    const token = await this.secureStore.getItem(this.tokenKey);
    if (!token) {
      return null;
    }

    try {
      const {authenticated} = await this.api.status();
      // status() itself doesn't take a token to check "for" - it reports
      // on whatever Authorization header the client just sent, which
      // StarCoreClient attaches from this same stored token (see
      // src/App.tsx's wiring) - so "authenticated: true" here already
      // means *this* token, not merely "some session somewhere is valid".
      if (!authenticated) {
        await this.clearStoredToken();
        return null;
      }
      return {token};
    } catch {
      // StarCore unreachable right now (server off, no network) - neither
      // confirmed valid nor confirmed invalid, so the token is left in
      // place for the next attempt rather than being thrown away over a
      // connectivity blip. The caller falls back to the login screen for
      // this launch either way.
      return null;
    }
  }

  async login(username: string, password: string): Promise<Session> {
    const token = await this.api.login(username, password, this.deviceInfo.displayName());
    await this.secureStore.setItem(this.tokenKey, token);
    return {token};
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // see AuthApi.logout()'s own docstring - local sign-out proceeds
      // regardless of whether StarCore could be reached just now
    }
    await this.clearStoredToken();
    // The biometric preference is deliberately kept: it may only be turned
    // off through disableBiometricUnlock, never as a side effect of signing
    // out (including the lock screen's password recovery).
  }

  /** Reads the stored preference without ever guessing: an unreadable
   * store is 'unknown', not 'off'. Retried once for transient Keystore
   * errors. */
  async biometricPreference(): Promise<'on' | 'off' | 'unknown'> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return (await this.secureStore.getItemStrict(this.biometricEnabledKey)) === 'true' ? 'on' : 'off';
      } catch {
        // retry once, then fall through
      }
    }
    return 'unknown';
  }

  /** Whether biometric protection applies for this server. Fails closed:
   * an unreadable preference counts as enabled, so a Keystore hiccup can
   * never open a protected server without authentication. Stored in
   * SecureStore, never AsyncStorage, so it can't be switched off by editing
   * plain app storage. */
  async biometricUnlockEnabled(): Promise<boolean> {
    return (await this.biometricPreference()) !== 'off';
  }

  async biometricsAvailable(): Promise<boolean> {
    return (await this.biometricAvailability()).available;
  }

  async biometricAvailability(): Promise<BiometricAvailability> {
    try {
      return await this.biometrics.isAvailable();
    } catch {
      return {available: false, biometryType: 'none', reason: 'unavailable'};
    }
  }

  /** Turns biometric unlock on: checks the sensor and enrollment, shows the
   * OS prompt, and only on a successful match stores the preference. The
   * session token itself is not moved or re-encrypted - the lock is
   * enforced in front of the UI (see appLock.ts) so background sync can
   * keep reading it. Never throws. */
  async enableBiometricUnlock(): Promise<BiometricEnableResult> {
    const confirmed = await this.confirmWithBiometrics('Confirm biometric unlock for StarCore');
    if (confirmed !== true) {
      return confirmed;
    }
    try {
      await this.secureStore.setItem(this.biometricEnabledKey, 'true');
    } catch {
      return 'failed';
    }
    if ((await this.biometricPreference()) === 'on') {
      return 'enabled';
    }
    // written but can't be read back: don't leave a preference behind that
    // the UI reports as off
    await this.secureStore.removeItem(this.biometricEnabledKey).catch(() => undefined);
    return 'failed';
  }

  /** Turns biometric unlock off. This is the only code path that ever
   * removes the preference, and it requires a successful biometric match.
   * The one exception is `passwordVerified`: the caller has just
   * re-authenticated against the real server with the password (the
   * recovery path), and biometrics can't be used on this device right now.
   * Never throws, and never touches the session token. */
  async disableBiometricUnlock(options: {passwordVerified?: boolean} = {}): Promise<BiometricDisableResult> {
    const availability = await this.biometricAvailability();
    if (!(options.passwordVerified && !availability.available)) {
      const confirmed = await this.confirmWithBiometrics('Confirm turning off biometric unlock for StarCore');
      if (confirmed !== true) {
        return confirmed;
      }
    }
    try {
      await this.secureStore.removeItem(this.biometricEnabledKey);
    } catch {
      return 'failed';
    }
    return (await this.biometricPreference()) === 'off' ? 'disabled' : 'failed';
  }

  private async confirmWithBiometrics(promptMessage: string): Promise<true | BiometricToggleResult> {
    const {available, reason} = await this.biometricAvailability();
    if (!available) {
      return reason === 'not-enrolled' ? 'not-enrolled' : 'unavailable';
    }
    try {
      return (await this.biometrics.authenticate(promptMessage)) === true ? true : 'cancelled';
    } catch {
      return 'cancelled';
    }
  }

  private async clearStoredToken(): Promise<void> {
    await this.secureStore.removeItem(this.tokenKey);
  }
}
