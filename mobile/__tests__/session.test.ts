import {BIOMETRIC_ENABLED_KEY, SessionManager, TOKEN_KEY} from '../src/auth/session';
import {FakeAuthApi, FakeBiometrics, FakeDeviceInfo, FakeSecureStore} from './fakes';

/**
 * The important authentication/session behavior the task brief asks this
 * block to cover: login, restore (including a revoked/expired token being
 * treated as signed-out, never trusted just because it's present locally),
 * logout clearing storage, and the biometric-unlock gate. No React Native
 * runtime is involved - see fakes.ts for why.
 */
describe('SessionManager', () => {
  function setUp() {
    const api = new FakeAuthApi();
    const secureStore = new FakeSecureStore();
    const biometrics = new FakeBiometrics();
    const deviceInfo = new FakeDeviceInfo();
    const manager = new SessionManager(api, secureStore, biometrics, deviceInfo);
    return {api, secureStore, biometrics, deviceInfo, manager};
  }

  describe('login', () => {
    it('stores the token on success and returns a session', async () => {
      const {api, secureStore, manager} = setUp();

      const session = await manager.login(api.correctUsername, api.correctPassword);

      expect(session.token).toEqual(expect.stringContaining('token-'));
      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
    });

    it('identifies the client as kind "mobile" with a device name', async () => {
      const {api, manager} = setUp();

      await manager.login(api.correctUsername, api.correctPassword);

      expect(api.loginCalls).toEqual([
        {username: api.correctUsername, password: api.correctPassword, deviceName: 'Test Device'},
      ]);
    });

    it('rejects the wrong password and stores nothing', async () => {
      const {api, secureStore, manager} = setUp();

      await expect(manager.login(api.correctUsername, 'wrong password')).rejects.toThrow();

      expect(await secureStore.getItem(TOKEN_KEY)).toBeNull();
    });

    it('never persists the password itself anywhere', async () => {
      const {api, secureStore, manager} = setUp();

      await manager.login(api.correctUsername, api.correctPassword);

      // FakeSecureStore is the entire storage surface SessionManager has -
      // if the password isn't in here, it was never stored at all
      expect((secureStore as any).values.get(TOKEN_KEY)).not.toBe(api.correctPassword);
      for (const value of (secureStore as any).values.values()) {
        expect(value).not.toBe(api.correctPassword);
      }
    });
  });

  describe('restore', () => {
    it('returns null when nothing is stored', async () => {
      const {manager} = setUp();

      expect(await manager.restore()).toBeNull();
    });

    it('returns a session for a token the server still accepts', async () => {
      const {api, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);

      const restored = await manager.restore();

      expect(restored).toEqual({token: session.token});
    });

    it('treats a revoked/expired token as signed out, and clears it locally', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      api.revoke(session.token); // e.g. revoked from "Active sessions" on another device

      const restored = await manager.restore();

      expect(restored).toBeNull();
      expect(await secureStore.getItem(TOKEN_KEY)).toBeNull();
    });

    it('never trusts a stored token without checking the server first', async () => {
      const {api, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);

      await manager.restore();

      expect(api.statusCalls).toBeGreaterThan(0);
    });

    it('keeps the token when the server cannot be reached, rather than deleting it', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      api.unreachable = true;

      const restored = await manager.restore();

      expect(restored).toBeNull(); // this launch still starts at the login screen...
      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token); // ...but nothing was thrown away
    });
  });

  describe('logout', () => {
    it('clears the stored token', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);

      await manager.logout();

      expect(await secureStore.getItem(TOKEN_KEY)).toBeNull();
    });

    it('tells the server to end the session', async () => {
      const {api, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);

      await manager.logout();

      expect(api.logoutCalls).toBe(1);
    });

    it('still clears local storage even if the server cannot be reached', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      api.logout = async () => {
        throw new Error('network error');
      };

      await manager.logout();

      expect(await secureStore.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('biometric unlock', () => {
    it('is disabled by default after a fresh login', async () => {
      const {api, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);

      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('stores the preference securely after a successful prompt', async () => {
      const {api, biometrics, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);

      expect(await manager.enableBiometricUnlock()).toBe('enabled');

      expect(biometrics.authenticateCalls).toHaveLength(1);
      expect(await secureStore.getItem(BIOMETRIC_ENABLED_KEY)).toBe('true');
      expect(await manager.biometricUnlockEnabled()).toBe(true);
    });

    it('persists across a new SessionManager (app restart)', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();

      const restarted = new SessionManager(api, secureStore, new FakeBiometrics(), new FakeDeviceInfo());

      expect(await restarted.biometricUnlockEnabled()).toBe(true);
    });

    it('leaves the session token where it was, readable without a prompt', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);

      await manager.enableBiometricUnlock();

      // background sync reads this with no UI - it must not move or be gated
      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
      expect(await manager.restore()).toEqual(session);
    });

    it('does not enable when the prompt is cancelled or fails', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      biometrics.authenticateResult = false;

      expect(await manager.enableBiometricUnlock()).toBe('cancelled');
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('treats an authenticator that throws as cancelled, never enabled', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      biometrics.authenticate = async () => {
        throw new Error('lockout');
      };

      expect(await manager.enableBiometricUnlock()).toBe('cancelled');
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('reports missing enrollment without prompting', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      biometrics.available = false;
      biometrics.reason = 'not-enrolled';

      expect(await manager.enableBiometricUnlock()).toBe('not-enrolled');
      expect(biometrics.authenticateCalls).toHaveLength(0);
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('reports missing hardware without prompting', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      biometrics.available = false;
      biometrics.reason = 'no-hardware';

      expect(await manager.enableBiometricUnlock()).toBe('unavailable');
      expect(biometrics.authenticateCalls).toHaveLength(0);
    });

    it('treats an availability check that throws as unavailable', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      biometrics.isAvailable = async () => {
        throw new Error('native error');
      };

      expect(await manager.enableBiometricUnlock()).toBe('unavailable');
      expect(await manager.biometricsAvailable()).toBe(false);
    });

    it("resolves 'failed', not a rejection, when the Keystore write fails", async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      secureStore.setItemWillFail = true;

      await expect(manager.enableBiometricUnlock()).resolves.toBe('failed');
      expect(await manager.biometricUnlockEnabled()).toBe(false);
      secureStore.setItemWillFail = false;
      expect(await manager.restore()).toEqual(session);
    });

    it('disabling requires a successful prompt and clears the stored preference', async () => {
      const {api, biometrics, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();

      expect(await manager.disableBiometricUnlock()).toBe('disabled');

      expect(biometrics.authenticateCalls).toHaveLength(2);
      expect(await secureStore.getItem(BIOMETRIC_ENABLED_KEY)).toBeNull();
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('a cancelled prompt keeps biometric unlock on', async () => {
      const {api, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      biometrics.authenticateResult = false;

      expect(await manager.disableBiometricUnlock()).toBe('cancelled');
      expect(await manager.biometricUnlockEnabled()).toBe(true);
    });

    it('cannot be disabled without biometrics, and keeps the session', async () => {
      const {api, biometrics, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      biometrics.available = false;
      biometrics.reason = 'not-enrolled';

      expect(await manager.disableBiometricUnlock()).toBe('not-enrolled');
      expect(await manager.biometricUnlockEnabled()).toBe(true);
      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
    });

    it('disabling never touches the session token', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();

      await manager.disableBiometricUnlock();

      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
    });

    it('logout keeps the preference: only an authenticated disable ever removes it', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();

      await manager.logout();

      expect(await secureStore.getItem(TOKEN_KEY)).toBeNull();
      expect(await secureStore.getItem(BIOMETRIC_ENABLED_KEY)).toBe('true');
      expect(await manager.biometricUnlockEnabled()).toBe(true);
    });

    it('keeps the preference through repeated launches with a dismissed prompt', async () => {
      const {api, secureStore, biometrics, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      biometrics.authenticate = async () => {
        // react-native-biometrics rejects when the prompt is dismissed by
        // tapping outside it (BiometricPrompt ERROR_CANCELED)
        throw new Error('Authentication canceled');
      };

      for (let launch = 0; launch < 3; launch += 1) {
        const relaunched = new SessionManager(api, secureStore, biometrics, new FakeDeviceInfo());
        expect(await relaunched.biometricUnlockEnabled()).toBe(true);
        expect(await relaunched.disableBiometricUnlock()).toBe('cancelled');
        expect(await relaunched.restore()).not.toBeNull(); // session untouched
      }
      expect(await secureStore.getItem(BIOMETRIC_ENABLED_KEY)).toBe('true');
    });

    it('fails closed: an unreadable store counts as enabled, never as off', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      secureStore.readsWillFail = true;

      expect(await manager.biometricPreference()).toBe('unknown');
      expect(await manager.biometricUnlockEnabled()).toBe(true);

      secureStore.readsWillFail = false;
      expect(await manager.biometricPreference()).toBe('on'); // nothing was lost
    });

    it('retries a transient read error once before giving up', async () => {
      const {api, secureStore, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      const real = secureStore.getItemStrict.bind(secureStore);
      let calls = 0;
      secureStore.getItemStrict = async key => {
        calls += 1;
        if (calls === 1) {
          throw new Error('transient');
        }
        return real(key);
      };

      expect(await manager.biometricPreference()).toBe('on');
    });

    it('reports a fresh install (nothing stored) as off', async () => {
      const {manager} = setUp();

      expect(await manager.biometricPreference()).toBe('off');
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    describe('password recovery', () => {
      it('turns it off without biometrics only after a password login, when biometrics are unavailable', async () => {
        const {api, biometrics, manager} = setUp();
        await manager.login(api.correctUsername, api.correctPassword);
        await manager.enableBiometricUnlock();
        biometrics.available = false;
        biometrics.reason = 'not-enrolled';
        biometrics.authenticateCalls = [];

        expect(await manager.disableBiometricUnlock({passwordVerified: true})).toBe('disabled');

        expect(biometrics.authenticateCalls).toHaveLength(0);
        expect(await manager.biometricUnlockEnabled()).toBe(false);
      });

      it('still requires biometrics when they are available, even after a password login', async () => {
        const {api, biometrics, manager} = setUp();
        await manager.login(api.correctUsername, api.correctPassword);
        await manager.enableBiometricUnlock();
        biometrics.authenticateResult = false;

        expect(await manager.disableBiometricUnlock({passwordVerified: true})).toBe('cancelled');
        expect(await manager.biometricUnlockEnabled()).toBe(true);
      });

      it('never turns it off without password proof when biometrics are unavailable', async () => {
        const {api, biometrics, manager} = setUp();
        await manager.login(api.correctUsername, api.correctPassword);
        await manager.enableBiometricUnlock();
        biometrics.available = false;
        biometrics.reason = 'no-hardware';

        expect(await manager.disableBiometricUnlock()).toBe('unavailable');
        expect(await manager.biometricUnlockEnabled()).toBe(true);
      });

      it('keeps the lock on across logout and a new password login', async () => {
        const {api, biometrics, secureStore, manager} = setUp();
        await manager.login(api.correctUsername, api.correctPassword);
        await manager.enableBiometricUnlock();
        biometrics.available = false;
        biometrics.reason = 'not-enrolled';

        await manager.logout();
        const session = await manager.login(api.correctUsername, api.correctPassword);

        expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
        expect(await manager.biometricUnlockEnabled()).toBe(true);
      });
    });

    it('keeps the preference when the server is unreachable at restore', async () => {
      const {api, manager} = setUp();
      await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock();
      api.unreachable = true;

      await manager.restore();

      expect(await manager.biometricUnlockEnabled()).toBe(true);
    });
  });

  describe('multiple servers (namespaced storage keys)', () => {
    /** AuthContext gives each server's SessionManager its own tokenKey/
     * biometricEnabledKey (see AuthProvider) so two servers' sessions on
     * the same device - sharing the same SecureStore - can never collide.
     * This is what that isolation actually rests on. */
    it('keeps two servers backed by the same SecureStore from reading or clearing each other', async () => {
      const secureStore = new FakeSecureStore();
      const apiA = new FakeAuthApi();
      const apiB = new FakeAuthApi();
      const managerA = new SessionManager(
        apiA, secureStore, new FakeBiometrics(), new FakeDeviceInfo(), `${TOKEN_KEY}:server-a`, `${BIOMETRIC_ENABLED_KEY}:server-a`,
      );
      const managerB = new SessionManager(
        apiB, secureStore, new FakeBiometrics(), new FakeDeviceInfo(), `${TOKEN_KEY}:server-b`, `${BIOMETRIC_ENABLED_KEY}:server-b`,
      );

      const sessionA = await managerA.login(apiA.correctUsername, apiA.correctPassword);
      const sessionB = await managerB.login(apiB.correctUsername, apiB.correctPassword);

      // separate FakeAuthApi instances (one per server, like the real
      // AuthApi/StarCoreClient pair AuthProvider builds per server) - their
      // tokens may coincide in value, which is exactly why storage
      // isolation (not token uniqueness) is what has to hold up
      expect(await managerA.restore()).toEqual(sessionA);
      expect(await managerB.restore()).toEqual(sessionB);

      await managerA.logout();

      expect(await managerA.restore()).toBeNull(); // server A signed out...
      expect(await managerB.restore()).toEqual(sessionB); // ...server B is untouched
    });

    it('keeps each server biometric preference separate', async () => {
      const secureStore = new FakeSecureStore();
      const apiA = new FakeAuthApi();
      const apiB = new FakeAuthApi();
      const managerA = new SessionManager(
        apiA, secureStore, new FakeBiometrics(), new FakeDeviceInfo(), `${TOKEN_KEY}:server-a`, `${BIOMETRIC_ENABLED_KEY}:server-a`,
      );
      const managerB = new SessionManager(
        apiB, secureStore, new FakeBiometrics(), new FakeDeviceInfo(), `${TOKEN_KEY}:server-b`, `${BIOMETRIC_ENABLED_KEY}:server-b`,
      );
      await managerA.login(apiA.correctUsername, apiA.correctPassword);
      const sessionB = await managerB.login(apiB.correctUsername, apiB.correctPassword);

      expect(await managerA.enableBiometricUnlock()).toBe('enabled');

      expect(await managerA.biometricUnlockEnabled()).toBe(true);
      expect(await managerB.biometricUnlockEnabled()).toBe(false);

      await managerA.logout();

      expect(await managerB.restore()).toEqual(sessionB);
      expect(await managerB.biometricUnlockEnabled()).toBe(false);
      expect(await managerA.biometricUnlockEnabled()).toBe(true); // A's preference survives its own logout
      expect(secureStore.keys().sort()).toEqual(
        [`${BIOMETRIC_ENABLED_KEY}:server-a`, `${TOKEN_KEY}:server-b`].sort(),
      );
    });

    it('defaults to the plain, single-server keys when none are given', async () => {
      const {api, manager, secureStore} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);

      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
    });
  });
});
