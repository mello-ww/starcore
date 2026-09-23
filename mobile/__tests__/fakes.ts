import type {AuthApiClient} from '../src/api/auth';
import type {AuthStatus} from '../src/api/types';
import type {BiometricAuthenticator, BiometryType, DeviceInfo, SecureStore} from '../src/platform/types';

/**
 * Plain in-memory fakes for every interface `SessionManager` depends on -
 * no native module, no network, no React Native runtime involved at all.
 * This is exactly why session.ts stays framework-free and depends only on
 * interfaces (see its own docstring): the important logic - restore,
 * login, logout, the biometric gate - is testable with nothing more than
 * this file.
 */

export class FakeSecureStore implements SecureStore {
  private values = new Map<string, string>();
  private gated = new Set<string>();

  /** Test control, not part of SecureStore itself: simulates whether the
   * next biometric-gated read succeeds or is cancelled/fails. */
  biometricReadWillSucceed = true;

  /** Test control: simulates the Keystore rejecting a write - e.g. binding
   * a `requireAuthentication` entry fails even after the OS prompt itself
   * already succeeded (see session.ts's enableBiometricUnlock docstring). */
  setItemWillFail = false;

  async setItem(key: string, value: string, options?: {requireAuthentication?: boolean}): Promise<void> {
    if (this.setItemWillFail) {
      throw new Error('Keystore write failed');
    }
    this.values.set(key, value);
    if (options?.requireAuthentication) {
      this.gated.add(key);
    } else {
      this.gated.delete(key);
    }
  }

  async getItem(key: string): Promise<string | null> {
    if (this.gated.has(key) && !this.biometricReadWillSucceed) {
      return null; // a cancelled/failed biometric prompt never throws - see the interface docstring
    }
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
    this.gated.delete(key);
  }

  isGated(key: string): boolean {
    return this.gated.has(key);
  }
}

export class FakeBiometrics implements BiometricAuthenticator {
  available = true;
  biometryType: BiometryType = 'fingerprint';
  authenticateResult = true;

  async isAvailable() {
    return {available: this.available, biometryType: this.biometryType};
  }

  async authenticate(): Promise<boolean> {
    return this.authenticateResult;
  }
}

export class FakeDeviceInfo implements DeviceInfo {
  displayName(): string {
    return 'Test Device';
  }
}

/** A fake StarCore server's worth of auth behavior - one bootstrapped
 * account, matching engine/starcore/auth.py's own semantics closely enough
 * to exercise SessionManager honestly (a wrong password fails, an invalid
 * token reports unauthenticated, ...) without spinning up any part of the
 * real Python server. */
export class FakeAuthApi implements AuthApiClient {
  private validTokens = new Set<string>();
  private nextTokenSuffix = 0;
  loginCalls: Array<{username: string; password: string; deviceName: string}> = [];
  logoutCalls = 0;
  statusCalls = 0;
  /** Simulates "the currently attached token" the way the real server's
   * session check works - StarCoreClient attaches whatever token is in
   * SecureStore, and status() reports on *that* token, not on some
   * separate notion of "am I logged in" the fake would otherwise invent. */
  currentToken: string | null = null;
  unreachable = false;

  readonly correctUsername = 'admin';
  readonly correctPassword = 'a very good password';

  async status(): Promise<AuthStatus> {
    this.statusCalls += 1;
    if (this.unreachable) {
      throw new Error('network error');
    }
    return {
      bootstrapped: true,
      authenticated: this.currentToken !== null && this.validTokens.has(this.currentToken),
    };
  }

  async login(username: string, password: string, deviceName: string): Promise<string> {
    this.loginCalls.push({username, password, deviceName});
    if (username !== this.correctUsername || password !== this.correctPassword) {
      const error: any = new Error('Invalid username or password.');
      error.status = 401;
      throw error;
    }
    const token = `token-${this.nextTokenSuffix++}`;
    this.validTokens.add(token);
    this.currentToken = token;
    return token;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
    if (this.currentToken) {
      this.validTokens.delete(this.currentToken);
    }
  }

  /** Test control: simulates the server revoking/expiring a token
   * out-of-band (from another device's "Active sessions" panel, or
   * natural expiry) - restore() must notice this, not just trust storage. */
  revoke(token: string): void {
    this.validTokens.delete(token);
  }
}
