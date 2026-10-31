import type {BiometricAuthenticator, BiometricAvailability} from '../platform/types';

/** How long the app may sit in the background before biometric unlock is
 * required again. Short trips out (a permission dialog, the share sheet,
 * the camera roll picker) shouldn't re-prompt. */
export const RELOCK_AFTER_BACKGROUND_MS = 30_000;

export type UnlockResult = 'unlocked' | 'cancelled' | 'not-enrolled' | 'unavailable';

type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/**
 * In-memory record of which servers' biometric unlock has been satisfied
 * in this foreground session. Nothing here is persisted: a cold start
 * always begins locked, and it never touches the session token or server
 * configs - locking only hides the UI (see RootNavigator), and the headless
 * background sync task never consults it.
 *
 * Keyed by server id because the preference is per server (see
 * SessionManager): unlocking one server doesn't unlock another.
 *
 * Framework-free so it can be unit tested with a fake clock and fake
 * biometrics - see __tests__/appLock.test.ts.
 */
export class AppLock {
  private unlocked = new Set<string>();
  private passwordVerified = new Set<string>();
  private backgroundedAt: number | null = null;
  private prompting = 0;
  private pendingUnlock: Promise<UnlockResult> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private biometrics: BiometricAuthenticator,
    private now: () => number = () => Date.now(),
    private relockAfterMs: number = RELOCK_AFTER_BACKGROUND_MS,
  ) {}

  isUnlocked(scope: string): boolean {
    return this.unlocked.has(scope) && !this.backgroundTimeoutElapsed();
  }

  /** For proofs of presence other than the lock screen: a fresh password
   * login (`viaPassword`), or the biometric prompt that just turned the
   * lock on. */
  markUnlocked(scope: string, viaPassword = false): void {
    this.unlocked.add(scope);
    if (viaPassword) {
      this.passwordVerified.add(scope);
    }
    this.notify();
  }

  /** True while the server's password was entered in this foreground
   * session - the only thing that allows the biometric preference to be
   * turned off without biometrics (see SessionManager.disableBiometricUnlock). */
  hasPasswordProof(scope: string): boolean {
    return this.passwordVerified.has(scope) && this.isUnlocked(scope);
  }

  /** Shows the biometric prompt and unlocks `scope` only on success.
   * Concurrent calls share one prompt. */
  unlock(scope: string, promptMessage: string): Promise<UnlockResult> {
    if (!this.pendingUnlock) {
      this.pendingUnlock = this.runUnlock(scope, promptMessage).finally(() => {
        this.pendingUnlock = null;
      });
    }
    return this.pendingUnlock;
  }

  handleAppStateChange(status: AppStateStatus): void {
    if (status === 'background') {
      // Some devices report a brief background while the system biometric
      // prompt is on screen; that must not start the relock timer.
      if (this.prompting === 0 && this.backgroundedAt === null) {
        this.backgroundedAt = this.now();
      }
    } else if (status === 'active') {
      const expired = this.backgroundTimeoutElapsed();
      this.backgroundedAt = null;
      if (expired && this.unlocked.size > 0) {
        this.unlocked.clear();
        this.passwordVerified.clear();
        this.notify();
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wraps an authenticator so every prompt it shows (including Settings'
   * enable/disable confirmations) is treated as in-app, not a trip to the
   * background. */
  guard(authenticator: BiometricAuthenticator): BiometricAuthenticator {
    return {
      isAvailable: () => authenticator.isAvailable(),
      authenticate: promptMessage => this.whilePrompting(() => authenticator.authenticate(promptMessage)),
    };
  }

  private async runUnlock(scope: string, promptMessage: string): Promise<UnlockResult> {
    let availability: BiometricAvailability;
    try {
      availability = await this.biometrics.isAvailable();
    } catch {
      return 'unavailable';
    }
    if (!availability.available) {
      return availability.reason === 'not-enrolled' ? 'not-enrolled' : 'unavailable';
    }
    let success = false;
    try {
      success = await this.whilePrompting(() => this.biometrics.authenticate(promptMessage));
    } catch {
      success = false;
    }
    if (success !== true) {
      return 'cancelled';
    }
    this.backgroundedAt = null;
    this.markUnlocked(scope);
    return 'unlocked';
  }

  private async whilePrompting<T>(fn: () => Promise<T>): Promise<T> {
    this.prompting += 1;
    try {
      return await fn();
    } finally {
      this.prompting -= 1;
    }
  }

  private backgroundTimeoutElapsed(): boolean {
    return this.backgroundedAt !== null && this.now() - this.backgroundedAt >= this.relockAfterMs;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
