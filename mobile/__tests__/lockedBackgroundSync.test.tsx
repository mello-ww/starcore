/**
 * Background Photo sync must keep working while the UI is biometrically
 * locked: the headless task reads the session token with no UI at all
 * (src/photo/backgroundSyncTask.ts), so the lock may only ever gate screens,
 * never the token in secure storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {BIOMETRIC_ENABLED_KEY, TOKEN_KEY} from '../src/auth/session';
import type {FakeBiometrics, FakeSecureStore} from './fakes';

jest.mock('../src/platform/secureStorage', () => {
  const {FakeSecureStore: Store} = require('./fakes');
  return {secureStorage: new Store()};
});
jest.mock('../src/platform/biometrics', () => {
  const {FakeBiometrics: Biometrics} = require('./fakes');
  return {biometrics: new Biometrics()};
});
jest.mock('../src/api/client', () => ({
  StarCoreClient: function (this: any, baseUrl: string, getToken: () => Promise<string | null>) {
    this.baseUrl = baseUrl;
    this.getToken = getToken;
  },
}));
jest.mock('../src/api/auth', () => ({
  AuthApi: jest.fn().mockImplementation(() => ({
    status: async () => ({bootstrapped: true, authenticated: true}),
    login: async () => 'unused',
    logout: async () => undefined,
  })),
}));
jest.mock('../src/photo/api', () => ({
  PhotoApi: function (this: any, client: unknown) {
    this.client = client;
  },
}));
jest.mock('../src/photo/backgroundSync', () => ({syncOneServer: jest.fn(() => Promise.resolve())}));
jest.mock('../src/photo/mediaPermission', () => ({hasMediaLibraryPermission: jest.fn(() => Promise.resolve(true))}));
jest.mock('@react-native-camera-roll/camera-roll', () => ({CameraRoll: {getPhotos: jest.fn()}}));
jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: {finish: jest.fn(), configure: jest.fn(), stop: jest.fn()},
}));
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({children}: {children: React.ReactNode}) => children,
  DarkTheme: {colors: {}},
}));
jest.mock('../src/components/Starfield', () => ({Starfield: () => null}));
jest.mock('../src/navigation/MainTabs', () => {
  const {Text: RNText} = require('react-native');
  return {MainTabs: () => require('react').createElement(RNText, {testID: 'main-tabs'}, 'main')};
});
jest.mock('../src/screens/LoginScreen', () => {
  const {Text: RNText} = require('react-native');
  return {LoginScreen: () => require('react').createElement(RNText, {testID: 'login-screen'}, 'login')};
});

import BackgroundFetch from 'react-native-background-fetch';
import {AuthProvider} from '../src/auth/AuthContext';
import {RootNavigator} from '../src/navigation/RootNavigator';
import {biometrics} from '../src/platform/biometrics';
import {secureStorage} from '../src/platform/secureStorage';
import {syncOneServer} from '../src/photo/backgroundSync';
import {backgroundFetchHeadlessTask, runBackgroundSync} from '../src/photo/backgroundSyncTask';

const store = secureStorage as unknown as FakeSecureStore;
const bio = biometrics as unknown as FakeBiometrics;
const syncMock = syncOneServer as jest.Mock;

const SERVERS = [
  {id: 'locked-srv', name: 'Locked', baseUrl: 'https://locked.example'},
  {id: 'open-srv', name: 'Open', baseUrl: 'https://open.example'},
];

const has = (tree: any, testID: string) =>
  tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string').length > 0;

async function renderLocked() {
  let tree!: any;
  await act(async () => {
    tree = renderer.create(
      <AuthProvider baseUrl="https://locked.example" serverId="locked-srv">
        <RootNavigator />
      </AuthProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
  return tree;
}

beforeEach(async () => {
  syncMock.mockClear();
  (BackgroundFetch.finish as jest.Mock).mockClear();
  await AsyncStorage.clear();
  await AsyncStorage.setItem('starcore_servers', JSON.stringify(SERVERS));
  for (const server of SERVERS) {
    await AsyncStorage.setItem(
      `starcore_photo_sync_state:${server.id}`,
      JSON.stringify({enabled: true, wifiOnly: false, lastSyncedAt: 0}),
    );
    await store.setItem(`${TOKEN_KEY}:${server.id}`, `token-${server.id}`);
  }
  await store.setItem(`${BIOMETRIC_ENABLED_KEY}:locked-srv`, 'true');
  bio.available = true;
  bio.authenticateResult = false; // the user never unlocks in these tests
  bio.authenticateCalls = [];
  bio.authenticate = async (message: string) => {
    bio.authenticateCalls.push(message);
    return false;
  };
});

describe('background sync while the UI is locked', () => {
  it('still syncs every server, reading the token without any biometric prompt', async () => {
    const tree = await renderLocked();
    expect(has(tree, 'lock-screen')).toBe(true);
    const promptsForLock = bio.authenticateCalls.length;

    await runBackgroundSync();

    expect(syncMock).toHaveBeenCalledTimes(2);
    const synced = Object.fromEntries(
      await Promise.all(
        syncMock.mock.calls.map(async ([serverId, , api]) => [serverId, await api.client.getToken()]),
      ),
    );
    expect(synced).toEqual({'locked-srv': 'token-locked-srv', 'open-srv': 'token-open-srv'});
    expect(bio.authenticateCalls).toHaveLength(promptsForLock); // the sync never prompted
    expect(has(tree, 'lock-screen')).toBe(true); // and never unlocked the UI
    expect(has(tree, 'main-tabs')).toBe(false);

    await act(async () => tree.unmount());
  });

  it('the headless task runs with no UI mounted at all and finishes its task id', async () => {
    await backgroundFetchHeadlessTask({taskId: 'headless-1'});

    expect(syncMock).toHaveBeenCalledTimes(2);
    expect(BackgroundFetch.finish).toHaveBeenCalledWith('headless-1');
    expect(bio.authenticateCalls).toHaveLength(0);
  });

  it('keeps the stored token and preference untouched by a locked UI and a sync run', async () => {
    const tree = await renderLocked();
    await runBackgroundSync();

    expect(await store.getItem(`${TOKEN_KEY}:locked-srv`)).toBe('token-locked-srv');
    expect(await store.getItem(`${BIOMETRIC_ENABLED_KEY}:locked-srv`)).toBe('true');

    await act(async () => tree.unmount());
  });

  it('a signed-out server is skipped, not failed, and does not stop the others', async () => {
    await store.removeItem(`${TOKEN_KEY}:locked-srv`);

    await runBackgroundSync();

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0][0]).toBe('open-srv');
  });
});
