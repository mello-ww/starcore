import {SessionManager, TOKEN_KEY} from '../src/auth/session';
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

    it('disable moves the token back to a plain, non-gated entry', async () => {
      const {api, secureStore, manager} = setUp();
      const session = await manager.login(api.correctUsername, api.correctPassword);
      await manager.enableBiometricUnlock(session);

      await manager.disableBiometricUnlock(session);

      expect(secureStore.isGated(TOKEN_KEY)).toBe(false);
      expect(await manager.biometricUnlockEnabled()).toBe(false);
    });
  });
});
