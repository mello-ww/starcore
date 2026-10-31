import {AppLock, RELOCK_AFTER_BACKGROUND_MS} from '../src/auth/appLock';
import {FakeBiometrics} from './fakes';

describe('AppLock', () => {
  function setUp() {
    let now = 1_000_000;
    const biometrics = new FakeBiometrics();
    const lock = new AppLock(biometrics, () => now);
    return {
      biometrics,
      lock,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('starts locked (cold start)', () => {
    const {lock} = setUp();

    expect(lock.isUnlocked('server-a')).toBe(false);
  });

  it('unlocks only after a successful prompt', async () => {
    const {lock, biometrics} = setUp();

    expect(await lock.unlock('server-a', 'Unlock')).toBe('unlocked');

    expect(biometrics.authenticateCalls).toEqual(['Unlock']);
    expect(lock.isUnlocked('server-a')).toBe(true);
  });

  it('stays locked when the prompt is cancelled or fails', async () => {
    const {lock, biometrics} = setUp();
    biometrics.authenticateResult = false;

    expect(await lock.unlock('server-a', 'Unlock')).toBe('cancelled');
    expect(lock.isUnlocked('server-a')).toBe(false);
  });

  it('stays locked when the authenticator throws', async () => {
    const {lock, biometrics} = setUp();
    biometrics.authenticate = async () => {
      throw new Error('hardware error');
    };

    expect(await lock.unlock('server-a', 'Unlock')).toBe('cancelled');
    expect(lock.isUnlocked('server-a')).toBe(false);
  });

  it('stays locked without prompting when nothing is enrolled or there is no sensor', async () => {
    const {lock, biometrics} = setUp();
    biometrics.available = false;
    biometrics.reason = 'not-enrolled';

    expect(await lock.unlock('server-a', 'Unlock')).toBe('not-enrolled');

    biometrics.reason = 'no-hardware';
    expect(await lock.unlock('server-a', 'Unlock')).toBe('unavailable');

    expect(biometrics.authenticateCalls).toHaveLength(0);
    expect(lock.isUnlocked('server-a')).toBe(false);
  });

  it('shares one prompt between concurrent unlock calls', async () => {
    const {lock, biometrics} = setUp();

    const results = await Promise.all([lock.unlock('server-a', 'Unlock'), lock.unlock('server-a', 'Unlock')]);

    expect(results).toEqual(['unlocked', 'unlocked']);
    expect(biometrics.authenticateCalls).toHaveLength(1);
  });

  it('keeps servers separate', async () => {
    const {lock} = setUp();

    await lock.unlock('server-a', 'Unlock');

    expect(lock.isUnlocked('server-a')).toBe(true);
    expect(lock.isUnlocked('server-b')).toBe(false);
  });

  describe('password proof', () => {
    it('is only set by a password login, and cleared when the app relocks', async () => {
      const {lock, advance} = setUp();
      await lock.unlock('server-a', 'Unlock');
      expect(lock.hasPasswordProof('server-a')).toBe(false); // a fingerprint is not password proof

      lock.markUnlocked('server-a', true);
      expect(lock.hasPasswordProof('server-a')).toBe(true);
      expect(lock.hasPasswordProof('server-b')).toBe(false);

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS);
      lock.handleAppStateChange('active');

      expect(lock.hasPasswordProof('server-a')).toBe(false);
    });
  });

  describe('background and foreground', () => {
    it('stays unlocked after a short trip to the background', async () => {
      const {lock, advance} = setUp();
      await lock.unlock('server-a', 'Unlock');

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS - 1);
      lock.handleAppStateChange('active');

      expect(lock.isUnlocked('server-a')).toBe(true);
    });

    it('relocks after the timeout and notifies subscribers once', async () => {
      const {lock, advance} = setUp();
      const listener = jest.fn();
      await lock.unlock('server-a', 'Unlock');
      lock.subscribe(listener);

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS);
      lock.handleAppStateChange('active');
      lock.handleAppStateChange('active');

      expect(lock.isUnlocked('server-a')).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reports locked while still in the background past the timeout', async () => {
      // e.g. the activity was destroyed and the UI remounts in the same JS
      // runtime before the 'active' event arrives
      const {lock, advance} = setUp();
      await lock.unlock('server-a', 'Unlock');

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS);

      expect(lock.isUnlocked('server-a')).toBe(false);
    });

    it('measures from the first background event, not repeated ones', async () => {
      const {lock, advance} = setUp();
      await lock.unlock('server-a', 'Unlock');

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS / 2);
      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS / 2);
      lock.handleAppStateChange('active');

      expect(lock.isUnlocked('server-a')).toBe(false);
    });

    it('ignores the background event some devices send while the prompt is showing', async () => {
      const {lock, biometrics, advance} = setUp();
      biometrics.authenticate = async () => {
        lock.handleAppStateChange('background');
        advance(RELOCK_AFTER_BACKGROUND_MS * 2);
        lock.handleAppStateChange('active');
        return true;
      };

      expect(await lock.unlock('server-a', 'Unlock')).toBe('unlocked');
      expect(lock.isUnlocked('server-a')).toBe(true);
    });

    it('also ignores backgrounding during guarded prompts (Settings confirmations)', async () => {
      const {lock, biometrics, advance} = setUp();
      await lock.unlock('server-a', 'Unlock');
      const guarded = lock.guard(biometrics);
      biometrics.authenticate = async () => {
        lock.handleAppStateChange('background');
        advance(RELOCK_AFTER_BACKGROUND_MS * 2);
        return true;
      };

      await guarded.authenticate('Confirm');
      lock.handleAppStateChange('active');

      expect(lock.isUnlocked('server-a')).toBe(true);
    });

    it('does not notify when nothing was unlocked', () => {
      const {lock, advance} = setUp();
      const listener = jest.fn();
      lock.subscribe(listener);

      lock.handleAppStateChange('background');
      advance(RELOCK_AFTER_BACKGROUND_MS);
      lock.handleAppStateChange('active');

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
