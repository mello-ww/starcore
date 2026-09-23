import type {AuthApiClient} from '../api/auth';
import type {BiometricAuthenticator, DeviceInfo, SecureStore} from '../platform/types';

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
    await this.secureStore.removeItem(this.biometricEnabledKey);
  }

  /** Whether biometric unlock has been turned on for the *currently
   * stored* token - not a general device capability check (see
   * `biometricsAvailable()` for that, used to decide whether to even show
   * the toggle). */
  async biometricUnlockEnabled(): Promise<boolean> {
    return (await this.secureStore.getItem(this.biometricEnabledKey)) === 'true';
  }

  async biometricsAvailable(): Promise<boolean> {
    const {available} = await this.biometrics.isAvailable();
    return available;
  }

  /** Re-stores the current session token behind the platform's biometric
   * gate (see `SecureStore.setItem`'s `requireAuthentication` option) -
   * from this point on, reading it back (including on the next app
   * launch's `restore()`) requires the OS's own biometric prompt to
   * succeed first. Confirms the sensor actually works on this device
   * before doing so, so a device that reports biometrics available but
   * then fails every prompt can't lock a user out of their own stored
   * session. */
  async enableBiometricUnlock(session: Session): Promise<boolean> {
    const confirmed = await this.biometrics.authenticate('Confirm biometric unlock for StarCore');
    if (!confirmed) {
      return false;
    }
    await this.secureStore.setItem(this.tokenKey, session.token, {requireAuthentication: true});
    await this.secureStore.setItem(this.biometricEnabledKey, 'true');
    return true;
  }

  async disableBiometricUnlock(session: Session): Promise<void> {
    await this.secureStore.setItem(this.tokenKey, session.token, {requireAuthentication: false});
    await this.secureStore.removeItem(this.biometricEnabledKey);
  }

  private async clearStoredToken(): Promise<void> {
    await this.secureStore.removeItem(this.tokenKey);
  }
}
