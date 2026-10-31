/**
 * Biometric app lock end to end through the real AuthProvider and
 * RootNavigator, with in-memory fakes for secure storage, biometrics and the
 * StarCore auth API. Covers startup lock/unlock, background/foreground,
 * enabling/disabling from a signed-in session, and multiple servers.
 *
 * The app lock is one per JS runtime (module level in AuthContext), so each
 * test uses its own server id to start from a clean, locked state.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert, AppState, BackHandler, Text} from 'react-native';
import {BIOMETRIC_ENABLED_KEY, TOKEN_KEY} from '../src/auth/session';
import {RELOCK_AFTER_BACKGROUND_MS} from '../src/auth/appLock';
import type {FakeAuthApi, FakeBiometrics, FakeSecureStore} from './fakes';

jest.mock('../src/platform/secureStorage', () => {
  const {FakeSecureStore: Store} = require('./fakes');
  return {secureStorage: new Store()};
});
jest.mock('../src/platform/biometrics', () => {
  const {FakeBiometrics: Biometrics} = require('./fakes');
  return {biometrics: new Biometrics()};
});
const mockApis = new Map<string, FakeAuthApi>();
jest.mock('../src/api/auth', () => ({
  AuthApi: jest.fn().mockImplementation((client: {baseUrl: string}) => {
    const {FakeAuthApi: Api} = require('./fakes');
    const key = (client as any).baseUrl;
    if (!mockApis.has(key)) {
      mockApis.set(key, new Api());
    }
    return mockApis.get(key);
  }),
}));
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({children}: {children: React.ReactNode}) => children,
  DarkTheme: {colors: {}},
}));
jest.mock('../src/components/Starfield', () => ({Starfield: () => null}));
jest.mock('../src/navigation/MainTabs', () => {
  const {Text: RNText} = require('react-native');
  const {useAuth} = require('../src/auth/AuthContext');
  return {
    MainTabs: () => {
      (globalThis as any).mockAuth = useAuth();
      return require('react').createElement(RNText, {testID: 'main-tabs'}, 'main');
    },
  };
});
jest.mock('../src/screens/LoginScreen', () => {
  const {Text: RNText} = require('react-native');
  const {useAuth} = require('../src/auth/AuthContext');
  return {
    LoginScreen: () => {
      (globalThis as any).mockAuth = useAuth();
      return require('react').createElement(RNText, {testID: 'login-screen'}, 'login');
    },
  };
});

import {AuthProvider} from '../src/auth/AuthContext';
import {RootNavigator} from '../src/navigation/RootNavigator';
import {secureStorage} from '../src/platform/secureStorage';
import {biometrics} from '../src/platform/biometrics';

const store = secureStorage as unknown as FakeSecureStore;
const bio = biometrics as unknown as FakeBiometrics;
const auth = () => (globalThis as any).mockAuth as ReturnType<typeof import('../src/auth/AuthContext').useAuth>;

let now = 5_000_000;
jest.spyOn(Date, 'now').mockImplementation(() => now);

function setAppState(status: 'active' | 'background') {
  for (const [, handler] of (AppState.addEventListener as jest.Mock).mock.calls) {
    handler(status);
  }
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

/** A server that's already signed in on this device, optionally with
 * biometric unlock turned on - what a cold start finds in storage. */
async function seedServer(serverId: string, {lockEnabled}: {lockEnabled: boolean}) {
  const {FakeAuthApi: Api} = require('./fakes');
  const api: FakeAuthApi = new Api();
  mockApis.set(`https://${serverId}`, api);
  const token = await api.login(api.correctUsername, api.correctPassword, 'Test Device');
  await store.setItem(`${TOKEN_KEY}:${serverId}`, token);
  if (lockEnabled) {
    await store.setItem(`${BIOMETRIC_ENABLED_KEY}:${serverId}`, 'true');
  }
  return {api, token};
}

const mounted: any[] = [];
const backToList = jest.fn();

async function renderApp(serverId: string) {
  let tree!: any;
  await act(async () => {
    tree = renderer.create(
      <AuthProvider baseUrl={`https://${serverId}`} serverId={serverId}>
        <RootNavigator onBackToServerList={backToList} />
      </AuthProvider>,
    );
  });
  mounted.push(tree);
  await flush();
  return tree;
}

const has = (tree: any, testID: string) =>
  tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string').length > 0;

function pressByTestId(tree: any, testID: string) {
  const node = tree.root.findAll((n: any) => n.props.testID === testID && n.props.onPress)[0];
  return act(async () => {
    node.props.onPress();
  });
}

/** Accepts the next confirm dialog by pressing its non-cancel button. */
function confirmNextAlert() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style !== 'cancel')?.onPress?.();
  });
}

function pressButton(tree: any, title: string) {
  const label = tree.root.findAll((node: any) => node.type === Text && node.props.children === title)[0];
  let node: any = label;
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  return act(async () => {
    node.props.onPress();
  });
}

afterEach(async () => {
  await act(async () => {
    mounted.splice(0).forEach(tree => tree.unmount());
  });
});

beforeEach(async () => {
  backToList.mockClear();
  store.readsWillFail = false;
  bio.available = true;
  bio.reason = undefined;
  bio.authenticateResult = true;
  bio.authenticateCalls = [];
  bio.authenticate = async (message: string) => {
    bio.authenticateCalls.push(message);
    return bio.authenticateResult;
  };
  bio.isAvailable = async () =>
    bio.available
      ? {available: true, biometryType: 'fingerprint' as const}
      : {available: false, biometryType: 'none' as const, reason: bio.reason ?? ('unavailable' as const)};
  // leave any background period from the previous test behind
  await act(async () => setAppState('active'));
});

describe('startup', () => {
  it('opens straight into the app when biometric unlock is off', async () => {
    await seedServer('plain', {lockEnabled: false});

    const tree = await renderApp('plain');

    expect(has(tree, 'main-tabs')).toBe(true);
    expect(has(tree, 'lock-screen')).toBe(false);
    expect(bio.authenticateCalls).toHaveLength(0);
  });

  it('shows only the lock screen and prompts once when biometric unlock is on', async () => {
    bio.authenticateResult = false;
    await seedServer('cold', {lockEnabled: true});

    const tree = await renderApp('cold');

    expect(has(tree, 'lock-screen')).toBe(true);
    expect(has(tree, 'main-tabs')).toBe(false); // nothing signed-in mounted behind it
    expect(bio.authenticateCalls).toHaveLength(1);
  });

  it('opens the app after a successful prompt', async () => {
    await seedServer('cold-ok', {lockEnabled: true});

    const tree = await renderApp('cold-ok');

    expect(bio.authenticateCalls).toHaveLength(1);
    expect(has(tree, 'lock-screen')).toBe(false);
    expect(has(tree, 'main-tabs')).toBe(true);
  });

  it('a cancelled prompt grants nothing, deletes nothing, and does not re-prompt by itself', async () => {
    bio.authenticateResult = false;
    const {token} = await seedServer('cancel', {lockEnabled: true});

    const tree = await renderApp('cancel');
    await flush();

    expect(has(tree, 'main-tabs')).toBe(false);
    expect(bio.authenticateCalls).toHaveLength(1);
    expect(await store.getItem(`${TOKEN_KEY}:cancel`)).toBe(token);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:cancel`)).toBe('true');

    bio.authenticateResult = true;
    await pressButton(tree, 'Unlock');
    await flush();

    expect(bio.authenticateCalls).toHaveLength(2);
    expect(has(tree, 'main-tabs')).toBe(true);
  });

  it('stays locked without prompting when no fingerprint is enrolled, and offers password sign-in', async () => {
    bio.available = false;
    bio.reason = 'not-enrolled';
    const {api} = await seedServer('no-enroll', {lockEnabled: true});

    const tree = await renderApp('no-enroll');

    expect(bio.authenticateCalls).toHaveLength(0);
    expect(has(tree, 'main-tabs')).toBe(false);
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children);
    expect(texts.join(' ')).toMatch(/No fingerprint is enrolled/);

    const alert = confirmNextAlert();
    await pressButton(tree, 'Sign in with password');
    await flush();
    alert.mockRestore();

    // an ordinary logout: the server password is required next
    expect(api.logoutCalls).toBe(1);
    expect(has(tree, 'login-screen')).toBe(true);
    expect(has(tree, 'main-tabs')).toBe(false);
    // ...and the lock itself is still on
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:no-enroll`)).toBe('true');
  });

  it('declining the password sign-in confirmation changes nothing', async () => {
    bio.available = false;
    bio.reason = 'not-enrolled';
    const {api} = await seedServer('decline', {lockEnabled: true});
    const tree = await renderApp('decline');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    await pressButton(tree, 'Sign in with password');
    alert.mockRestore();

    expect(api.logoutCalls).toBe(0);
    expect(has(tree, 'lock-screen')).toBe(true);
    expect(await store.getItem(`${TOKEN_KEY}:decline`)).not.toBeNull();
  });

  it('does not lock when there is no valid session (password login is required anyway)', async () => {
    const {api, token} = await seedServer('revoked', {lockEnabled: true});
    api.revoke(token);

    const tree = await renderApp('revoked');

    expect(has(tree, 'login-screen')).toBe(true);
    expect(has(tree, 'lock-screen')).toBe(false);
    expect(bio.authenticateCalls).toHaveLength(0);
  });

  it('a password login unlocks that server and keeps its stored preference', async () => {
    const {api, token} = await seedServer('relogin', {lockEnabled: true});
    api.revoke(token);
    const tree = await renderApp('relogin');

    await act(async () => {
      await auth().login(api.correctUsername, api.correctPassword);
    });
    await flush();

    expect(has(tree, 'main-tabs')).toBe(true);
    expect(auth().biometricUnlockEnabled).toBe(true);
    expect(auth().locked).toBe(false);
  });
});

describe('background and foreground', () => {
  async function unlockedApp(serverId: string) {
    await seedServer(serverId, {lockEnabled: true});
    const tree = await renderApp(serverId);
    expect(has(tree, 'main-tabs')).toBe(true);
    bio.authenticateCalls = [];
    return tree;
  }

  it('does not prompt again after a short trip to the background', async () => {
    const tree = await unlockedApp('short-bg');

    await act(async () => setAppState('background'));
    now += RELOCK_AFTER_BACKGROUND_MS - 1000;
    await act(async () => setAppState('active'));
    await flush();

    expect(bio.authenticateCalls).toHaveLength(0);
    expect(has(tree, 'lock-screen')).toBe(false);
  });

  it('relocks after the timeout with the app kept mounted underneath, and prompts once', async () => {
    bio.authenticateResult = true;
    const tree = await unlockedApp('long-bg');
    bio.authenticateResult = false;

    await act(async () => setAppState('background'));
    now += RELOCK_AFTER_BACKGROUND_MS;
    await act(async () => setAppState('active'));
    await flush();
    await act(async () => setAppState('active'));
    await flush();

    expect(has(tree, 'lock-screen')).toBe(true);
    expect(has(tree, 'main-tabs')).toBe(true); // navigation state survives...
    const hidden = tree.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props.importantForAccessibility === 'no-hide-descendants',
    );
    expect(hidden).toHaveLength(1); // ...but it's hidden from touch and accessibility
    expect(hidden[0].props.pointerEvents).toBe('none');
    expect(bio.authenticateCalls).toHaveLength(1);

    bio.authenticateResult = true;
    await pressButton(tree, 'Unlock');
    await flush();

    expect(has(tree, 'lock-screen')).toBe(false);
    expect(has(tree, 'main-tabs')).toBe(true);
  });

  it('routes hardware back to the server list while locked, not to the hidden navigator', async () => {
    bio.authenticateResult = false;
    await seedServer('back', {lockEnabled: true});
    const exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined);
    const addListener = jest.spyOn(BackHandler, 'addEventListener');

    await renderApp('back');
    const handler = addListener.mock.calls[addListener.mock.calls.length - 1][1];

    expect(handler()).toBe(true);
    expect(backToList).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
    exitApp.mockRestore();
    addListener.mockRestore();
  });
});

describe('prompt dismissed by tapping outside, cancellation and persistence', () => {
  const tapOutside = async (message: string) => {
    bio.authenticateCalls.push(message);
    // react-native-biometrics rejects for BiometricPrompt's ERROR_CANCELED
    throw new Error('Authentication canceled');
  };

  it('never grants access, and never disables the lock, across repeated launches', async () => {
    const {api, token} = await seedServer('tap-outside', {lockEnabled: true});
    bio.authenticate = tapOutside;

    for (let launch = 1; launch <= 3; launch += 1) {
      const tree = await renderApp('tap-outside');

      expect(has(tree, 'lock-screen')).toBe(true);
      expect(has(tree, 'main-tabs')).toBe(false);
      expect(bio.authenticateCalls).toHaveLength(launch); // one automatic prompt per launch, no loop
      expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:tap-outside`)).toBe('true');
      expect(await store.getItem(`${TOKEN_KEY}:tap-outside`)).toBe(token);
      await act(async () => tree.unmount());
    }
    expect(api.logoutCalls).toBe(0);
  });

  it('a later successful launch still unlocks normally', async () => {
    await seedServer('tap-then-ok', {lockEnabled: true});
    bio.authenticate = tapOutside;
    const first = await renderApp('tap-then-ok');
    expect(has(first, 'lock-screen')).toBe(true);
    await act(async () => first.unmount());

    bio.authenticate = async () => true;
    const second = await renderApp('tap-then-ok');

    expect(has(second, 'main-tabs')).toBe(true);
    expect(has(second, 'lock-screen')).toBe(false);
  });

  it('retrying with the Unlock button after a dismissal works', async () => {
    await seedServer('tap-retry', {lockEnabled: true});
    bio.authenticate = tapOutside;
    const tree = await renderApp('tap-retry');
    expect(texts(tree)).toMatch(/Unlock was cancelled/);

    bio.authenticate = async () => true;
    await pressButton(tree, 'Unlock');
    await flush();

    expect(has(tree, 'main-tabs')).toBe(true);
  });

  it('a failed (non-matching) attempt behaves like a dismissal', async () => {
    const {token} = await seedServer('mismatch', {lockEnabled: true});
    bio.authenticateResult = false;

    const tree = await renderApp('mismatch');

    expect(has(tree, 'main-tabs')).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:mismatch`)).toBe('true');
    expect(await store.getItem(`${TOKEN_KEY}:mismatch`)).toBe(token);
  });

  it('an unreadable preference keeps the app locked instead of opening it (fails closed)', async () => {
    await seedServer('unreadable', {lockEnabled: true});
    const realStrict = store.getItemStrict.bind(store);
    store.getItemStrict = async key => {
      if (key === `${BIOMETRIC_ENABLED_KEY}:unreadable`) {
        throw new Error('Keystore read failed');
      }
      return realStrict(key);
    };
    bio.authenticateResult = false;

    const tree = await renderApp('unreadable');
    store.getItemStrict = realStrict;

    expect(has(tree, 'lock-screen')).toBe(true);
    expect(has(tree, 'main-tabs')).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:unreadable`)).toBe('true'); // nothing was lost
  });

  it('Back on the lock screen is not an unlock and not a disable', async () => {
    const {api, token} = await seedServer('lock-back', {lockEnabled: true});
    bio.authenticateResult = false;
    const tree = await renderApp('lock-back');
    const promptsBefore = bio.authenticateCalls.length;

    await pressByTestId(tree, 'lock-back-button');

    expect(backToList).toHaveBeenCalledTimes(1);
    expect(bio.authenticateCalls).toHaveLength(promptsBefore);
    expect(has(tree, 'main-tabs')).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:lock-back`)).toBe('true');
    expect(await store.getItem(`${TOKEN_KEY}:lock-back`)).toBe(token);
    expect(api.logoutCalls).toBe(0);

    // selecting the same server again (a new mount) still requires unlocking
    await act(async () => tree.unmount());
    const again = await renderApp('lock-back');
    expect(has(again, 'lock-screen')).toBe(true);
  });
});

describe('password recovery when biometrics become unavailable', () => {
  it('re-authenticates with the server, keeps the lock, and only then allows turning it off', async () => {
    bio.available = false;
    bio.reason = 'not-enrolled';
    const {api} = await seedServer('recover', {lockEnabled: true});
    const tree = await renderApp('recover');
    expect(has(tree, 'lock-screen')).toBe(true);

    const alert = confirmNextAlert();
    await pressButton(tree, 'Sign in with password');
    await flush();
    alert.mockRestore();
    expect(has(tree, 'login-screen')).toBe(true);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:recover`)).toBe('true');

    // wrong password: no access
    await act(async () => {
      await auth().login(api.correctUsername, 'wrong').catch(() => undefined);
    });
    expect(has(tree, 'main-tabs')).toBe(false);

    await act(async () => {
      await auth().login(api.correctUsername, api.correctPassword);
    });
    await flush();

    expect(has(tree, 'main-tabs')).toBe(true);
    expect(auth().biometricUnlockEnabled).toBe(true); // still on
    expect(auth().passwordRecoveryAvailable).toBe(true);

    let result: string | undefined;
    await act(async () => {
      result = await auth().disableBiometricUnlock();
    });

    expect(result).toBe('disabled');
    expect(bio.authenticateCalls).toHaveLength(0); // no biometric prompt was possible or needed
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:recover`)).toBeNull();
    expect(await store.getItem(`${TOKEN_KEY}:recover`)).not.toBeNull();
  });

  it('is not available without a password login, so biometrics cannot be bypassed', async () => {
    await seedServer('no-proof', {lockEnabled: true});
    await renderApp('no-proof'); // unlocked by fingerprint, not by password
    bio.available = false;
    bio.reason = 'no-hardware';
    await act(async () => setAppState('active'));
    await flush();

    expect(auth().passwordRecoveryAvailable).toBe(false);
    let result: string | undefined;
    await act(async () => {
      result = await auth().disableBiometricUnlock();
    });
    expect(result).toBe('unavailable');
    expect(auth().biometricUnlockEnabled).toBe(true);
  });
});

function texts(tree: any): string {
  return tree.root
    .findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat()
    .join(' ');
}

describe('enabling and disabling from Settings', () => {
  it('enabling updates immediately, persists, and does not lock the current session', async () => {
    await seedServer('enable', {lockEnabled: false});
    const tree = await renderApp('enable');

    let result: string | undefined;
    await act(async () => {
      result = await auth().enableBiometricUnlock();
    });
    await flush();

    expect(result).toBe('enabled');
    expect(auth().biometricUnlockEnabled).toBe(true);
    expect(auth().locked).toBe(false);
    expect(has(tree, 'lock-screen')).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:enable`)).toBe('true');

    // the next start (here: a remount after a long background) is locked
    await act(async () => tree.unmount());
    await act(async () => setAppState('background'));
    now += RELOCK_AFTER_BACKGROUND_MS;
    bio.authenticateResult = false;
    const restarted = await renderApp('enable');

    expect(has(restarted, 'lock-screen')).toBe(true);
    expect(has(restarted, 'main-tabs')).toBe(false);
  });

  it('a cancelled enable prompt leaves it off', async () => {
    await seedServer('enable-cancel', {lockEnabled: false});
    await renderApp('enable-cancel');
    bio.authenticateResult = false;

    let result: string | undefined;
    await act(async () => {
      result = await auth().enableBiometricUnlock();
    });

    expect(result).toBe('cancelled');
    expect(auth().biometricUnlockEnabled).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:enable-cancel`)).toBeNull();
  });

  it('reports missing enrollment through the context', async () => {
    bio.available = false;
    bio.reason = 'not-enrolled';
    await seedServer('enable-noenroll', {lockEnabled: false});
    await renderApp('enable-noenroll');

    expect(auth().biometricsAvailable).toBe(false);
    expect(auth().biometricsUnavailableReason).toBe('not-enrolled');
  });

  it('refreshes availability when the app returns to the foreground', async () => {
    bio.available = false;
    bio.reason = 'not-enrolled';
    await seedServer('enroll-later', {lockEnabled: false});
    await renderApp('enroll-later');

    bio.available = true; // fingerprint added in Android Settings
    await act(async () => setAppState('active'));
    await flush();

    expect(auth().biometricsAvailable).toBe(true);
  });

  it('disabling requires a successful prompt and updates storage', async () => {
    await seedServer('disable', {lockEnabled: true});
    await renderApp('disable');
    bio.authenticateCalls = [];

    bio.authenticateResult = false;
    let result: string | undefined;
    await act(async () => {
      result = await auth().disableBiometricUnlock();
    });
    expect(result).toBe('cancelled');
    expect(auth().biometricUnlockEnabled).toBe(true);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:disable`)).toBe('true');

    bio.authenticateResult = true;
    await act(async () => {
      result = await auth().disableBiometricUnlock();
    });
    expect(result).toBe('disabled');
    expect(bio.authenticateCalls).toHaveLength(2);
    expect(auth().biometricUnlockEnabled).toBe(false);
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:disable`)).toBeNull();
    expect(await store.getItem(`${TOKEN_KEY}:disable`)).not.toBeNull();
  });
});

describe('multiple servers', () => {
  it('locks each server by its own preference, and unlocking one does not unlock another', async () => {
    await seedServer('multi-a', {lockEnabled: true});
    await seedServer('multi-b', {lockEnabled: true});
    await seedServer('multi-c', {lockEnabled: false});

    const a = await renderApp('multi-a');
    expect(has(a, 'main-tabs')).toBe(true); // unlocked by the auto prompt
    await act(async () => a.unmount());

    // switching servers remounts AuthProvider (App.tsx keys it by server id)
    bio.authenticateResult = false;
    const b = await renderApp('multi-b');
    expect(has(b, 'lock-screen')).toBe(true);
    expect(has(b, 'main-tabs')).toBe(false);
    await act(async () => b.unmount());

    const c = await renderApp('multi-c');
    expect(has(c, 'main-tabs')).toBe(true);
    await act(async () => c.unmount());

    // and back to A within the same foreground session: no new prompt
    bio.authenticateCalls = [];
    const aAgain = await renderApp('multi-a');
    expect(has(aAgain, 'main-tabs')).toBe(true);
    expect(bio.authenticateCalls).toHaveLength(0);
  });

  it('a failed unlock never touches any server session', async () => {
    const a = await seedServer('keep-a', {lockEnabled: true});
    const b = await seedServer('keep-b', {lockEnabled: false});
    bio.authenticateResult = false;

    await renderApp('keep-a');

    expect(await store.getItem(`${TOKEN_KEY}:keep-a`)).toBe(a.token);
    expect(await store.getItem(`${TOKEN_KEY}:keep-b`)).toBe(b.token);
    expect(a.api.logoutCalls).toBe(0);
  });
});
