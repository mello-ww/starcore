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

    it('moves the token behind the platform biometric gate once enabled', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);

      const enabled = await manager.enableBiometricUnlock(session);

      expect(enabled).toBe(true);
      expect(secureStore.isGated(TOKEN_KEY)).toBe(true);
      expect(await manager.biometricUnlockEnabled()).toBe(true);
    });

    it('does not enable the gate if the confirmation prompt fails', async () => {
      const {api, biometrics, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      biometrics.authenticateResult = false;

      const enabled = await manager.enableBiometricUnlock(session);

      expect(enabled).toBe(false);
      expect(secureStore.isGated(TOKEN_KEY)).toBe(false);
    });

    it('a cancelled biometric prompt on restore falls back to signed-out, not a crash', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock(session);
      secureStore.biometricReadWillSucceed = false;

      const restored = await manager.restore();

      expect(restored).toBeNull();
    });

    it('resolves false, not a rejection, when the Keystore write fails after a successful prompt', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      secureStore.setItemWillFail = true;

      await expect(manager.enableBiometricUnlock(session)).resolves.toBe(false);
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('leaves password sign-in working after a Keystore write failure', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      secureStore.setItemWillFail = true;
      await manager.enableBiometricUnlock(session);
      secureStore.setItemWillFail = false;

      expect(await manager.restore()).toEqual({token: session.token});
    });

    it('disabling never rejects even if the Keystore write fails', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock(session);
      secureStore.setItemWillFail = true;

      await expect(manager.disableBiometricUnlock(session)).resolves.toBeUndefined();
      // biometricEnabledKey is cleared regardless, so the UI reflects "off"
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });

    it('disable moves the token back to a plain, non-gated entry', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock(session);

      await manager.disableBiometricUnlock(session);

      expect(secureStore.isGated(TOKEN_KEY)).toBe(false);
      expect(await manager.biometricUnlockEnabled()).toBe(false);
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

    it('defaults to the plain, single-server keys when none are given', async () => {
      const {api, manager, secureStore} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);

      expect(await secureStore.getItem(TOKEN_KEY)).toBe(session.token);
    });
  });
});
