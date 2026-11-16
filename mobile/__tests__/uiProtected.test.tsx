import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Image, NativeModules, Pressable, Text, TextInput} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {KEEP_SECONDS, LEAVE_GRACE_SECONDS} from '../src/vault/gate';

// A protected document (UI contract 1.2) on the app's shared screen: nothing of the page before
// the store's own status says it may show; locked, the app's unlock card asks for a full unlock
// of this session; open, the page - kept alive while shown, locked when left. It keeps nothing:
// no offline copy, images from memory only, no capture, and no control that leaves a copy.

const mockClient = {get: jest.fn(), post: jest.fn()};
jest.mock('../src/auth/AuthContext', () => ({
  useAuth: jest.fn(() => ({client: mockClient, state: {status: 'signed-in', session: {token: 'session-one'}}})),
}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1', baseUrl: 'https://s.test'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/platform/privacy', () => ({privacy: {evictImages: jest.fn(), setSecure: jest.fn()}}));
jest.mock('../src/platform/biometrics', () => ({biometricSigner: {}, biometrics: {}}));
jest.mock('../src/platform/secureStorage', () => ({secureStorage: {}}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {__mocks: Record<string, jest.Mock>};
const {privacy} = jest.requireMock('../src/platform/privacy') as {privacy: {setSecure: jest.Mock}};

const DOCUMENT = {
  contract: 'starcore.ui/1.2',
  title: 'Safe',
  entry: 'home',
  protected: {capability: 'media.vault', setup: 'setup', forgot: 'forgot'},
  pages: {
    home: {
      source: {route: 'items'},
      blocks: [
        {type: 'media-grid', id: 'items', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'}},
        {type: 'button', label: 'Open it', action: {download: 'file/a', open: true}},
        {type: 'button', label: 'Save it', action: {download: 'file/a'}},
        {type: 'button', label: 'Albums', action: {section: 'Albums'}},
        {type: 'button', label: 'Ghost', action: {section: 'Ghost'}},
      ],
    },
    setup: {blocks: [{type: 'text', text: 'Set a PIN first.'}]},
    forgot: {source: {route: 'setup?forgot=1'}, blocks: [{type: 'text', text: 'Use your recovery key.'}]},
  },
};
const VAULT = {satellite: 'Safe', version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', keep: 'keep'}};
const OPEN = {configured: true, pin_set: true, unlocked: true, expires_at: 'later'};
const LOCKED = {configured: true, pin_set: true, unlocked: false, expires_at: null};
const HOSTED = [{name: 'Albums', section_of: 'Safe', ui: {revision: 'a1'}}, {name: 'Ghost', section_of: 'Elsewhere', ui: {revision: 'g1'}}];

let server: {status: any; keep: number; unlockWith: string};
function answer() {
  mockClient.get.mockImplementation(async (path: string) => {
    if (path === '/api/satellites/Safe/status') {
      return {status: 200, body: server.status};
    }
    if (path === '/api/satellites') {
      return {status: 200, body: {satellites: HOSTED}};
    }
    return {status: 404, body: {}};
  });
  mockClient.post.mockImplementation(async (path: string, body: any) => {
    if (path === '/api/satellites/Safe/unlock') {
      if (body.pin !== server.unlockWith) {
        return {status: 401, body: {error: 'Incorrect PIN.'}};
      }
      server.status = OPEN;
      return {status: 200, body: {unlocked: true, expires_at: 'later'}};
    }
    if (path === '/api/satellites/Safe/keep') {
      server.keep += 1;
      return server.status.unlocked ? {status: 200, body: {expires_at: 'later'}} : {status: 403, body: {error: 'locked'}};
    }
    if (path === '/api/satellites/Safe/lock') {
      server.status = LOCKED;
      return {status: 200, body: {unlocked: false}};
    }
    return {status: 404, body: {}};
  });
}

const mounted: ReturnType<typeof renderer.create>[] = [];
async function mount() {
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={{params: {name: 'Safe', revision: 'r'}} as any} />);
  });
  mounted.push(tree);
  await settle();
  return {tree, navigation};
}
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
};
const texts = (tree: any): string[] => tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
const byId = (tree: any, id: string) => tree.root.findAll((node: any) => node.props.testID === id && typeof node.type !== 'string');
const control = (tree: any, label: string) =>
  tree.root.findAll(
    (node: any) => node.type === Pressable && [node.props.accessibilityLabel, ...texts({root: node})].includes(label),
  )[0];
const pageReads = () => __mocks.read.mock.calls.filter(([, route]) => route !== 'status');

async function unlock(tree: any, pin: string) {
  const field = tree.root.findAllByType(TextInput).find((node: any) => node.props.accessibilityLabel === 'PIN');
  await act(async () => field.props.onChangeText(pin));
  await act(async () => field.props.onSubmitEditing());
  await settle();
}

describe('a protected document on the app’s shared screen', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.clear();
    Object.values(__mocks).forEach(mock => mock.mockReset());
    mockClient.get.mockReset();
    mockClient.post.mockReset();
    privacy.setSecure.mockClear();
    server = {status: LOCKED, keep: 0, unlockWith: '2468'};
    answer();
    (NativeModules as any).StarCoreFiles = {canSave: true, canShare: true, canOpen: true};
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'r', offline: false});
    __mocks.providers.mockResolvedValue({'media.vault': [VAULT]});
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => (route === 'items' ? {items: [{id: 'a'}, {id: 'b'}]} : {}));
    // an image fetched into memory: a data URI, never a URL for the image loader's disk cache
    (globalThis as any).fetch = jest.fn(async () => ({ok: true, status: 200, blob: async () => 'BYTES'}));
    (globalThis as any).FileReader = class {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:image/jpeg;base64,QUJD';
        Promise.resolve().then(() => this.onloadend?.());
      }
    };
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    delete (NativeModules as any).StarCoreFiles;
  });

  it('locked: the app’s own card, and nothing of the page asked for', async () => {
    const {tree} = await mount();
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Safe is locked']));
    expect(pageReads()).toEqual([]);
    expect(privacy.setSecure).toHaveBeenCalledWith(true); // no screenshots, no recents thumbnail
  });

  it('a wrong PIN asks again; the right one opens the page, and the PIN goes only to the unlock', async () => {
    const {tree} = await mount();
    await unlock(tree, '0000');
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
    expect(texts(tree).join(' ')).toMatch(/incorrect/i);
    expect(pageReads()).toEqual([]);

    await unlock(tree, '2468');
    expect(byId(tree, 'vault-unlock')).toHaveLength(0);
    expect(pageReads().map(([, route]) => route)).toEqual(['items']);
    const sent = [...mockClient.post.mock.calls, ...__mocks.read.mock.calls, ...__mocks.act.mock.calls]
      .filter(([path]) => path !== '/api/satellites/Safe/unlock');
    expect(JSON.stringify(sent)).not.toContain('2468');
    // the page's images come from memory, never handed to the loader by URL
    const sources = tree.root.findAllByType(Image).map((node: any) => node.props.source?.uri).filter(Boolean);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((uri: string) => uri.startsWith('data:'))).toBe(true);
    expect((globalThis as any).fetch).toHaveBeenCalledWith(
      'https://s.test/api/satellites/Safe/thumbs/a',
      expect.objectContaining({headers: expect.objectContaining({Authorization: 'Bearer session-one'})}),
    );
  });

  it('unlocked already: it opens at once, and keeps the unlock alive while shown', async () => {
    server.status = OPEN;
    const {tree} = await mount();
    expect(byId(tree, 'vault-unlock')).toHaveLength(0);
    expect(pageReads()).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(KEEP_SECONDS * 1000 * 2);
    });
    await settle();
    expect(server.keep).toBe(2);
  });

  it('locked again on the server: the card again at the next keep, and the page forgotten', async () => {
    server.status = OPEN;
    const {tree} = await mount();
    expect(texts(tree)).not.toContain('Safe is locked');
    server.status = LOCKED; // the server's idle time, or another device locked it
    await act(async () => {
      jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    });
    await settle();
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
    expect(tree.root.findAllByType(Image).filter((node: any) => node.props.source?.uri)).toHaveLength(0);
  });

  it('a 403 from the page’s own routes asks status again instead of showing an error', async () => {
    server.status = OPEN;
    const {tree} = await mount();
    server.status = LOCKED;
    __mocks.read.mockRejectedValue(Object.assign(new Error('Unlock first.'), {status: 403}));
    const refresh = tree.root.findAll((node: any) => typeof node.props.onRefresh === 'function')[0];
    await act(async () => refresh.props.onRefresh());
    await settle();
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
    expect(texts(tree)).not.toContain('Unlock first.');
  });

  it('leaving the document locks it', async () => {
    server.status = OPEN;
    const {tree} = await mount();
    act(() => tree.unmount());
    mounted.splice(0);
    await settle();
    expect(mockClient.post).toHaveBeenCalledWith('/api/satellites/Safe/lock', {});
  });

  it('hidden past the grace (the app in the background), it locks', async () => {
    server.status = OPEN;
    const {AppState} = require('react-native');
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type: any, listener: any) => {
      listeners.push(listener);
      return {remove: jest.fn()} as any;
    });
    const {tree} = await mount();
    await act(async () => listeners.forEach(listener => listener('background')));
    await act(async () => {
      jest.advanceTimersByTime(LEAVE_GRACE_SECONDS * 1000);
    });
    await settle();
    expect(mockClient.post).toHaveBeenCalledWith('/api/satellites/Safe/lock', {});
    await act(async () => listeners.forEach(listener => listener('active')));
    await settle();
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
  });

  it('keeps nothing offline and offers nothing that leaves a copy', async () => {
    server.status = OPEN;
    const {tree} = await mount();
    expect((await AsyncStorage.getAllKeys()).filter(key => key.includes('Safe'))).toEqual([]);
    expect(control(tree, 'Open it')).toBeUndefined(); // it would leave the file in the app's cache
    expect(control(tree, 'Save it')).toBeDefined(); // a download is the person's own choice
  });

  it('opens a Satellite it hosts over itself, and only one it hosts', async () => {
    server.status = OPEN;
    const {tree, navigation} = await mount();
    expect(control(tree, 'Ghost')).toBeUndefined(); // a section of another Satellite
    await act(async () => control(tree, 'Albums').props.onPress());
    expect(navigation.push).toHaveBeenCalledWith('SatelliteUi', {name: 'Albums', revision: 'a1'});
  });

  it('a store that isn’t set up shows the document’s setup page, and nothing to lock', async () => {
    server.status = {configured: true, pin_set: false, unlocked: false, expires_at: null};
    const {tree} = await mount();
    expect(byId(tree, 'vault-unlock')).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Set a PIN first.']));
    expect(pageReads()).toEqual([]);
    act(() => tree.unmount());
    mounted.splice(0);
    await settle();
    expect(mockClient.post).not.toHaveBeenCalledWith('/api/satellites/Safe/lock', {});
  });

  it('forgot your PIN: the forgot page instead of the card, nothing unlocked, and back to the card', async () => {
    const {tree} = await mount();
    await act(async () => byId(tree, 'vault-forgot')[0].props.onPress());
    await settle();
    expect(byId(tree, 'vault-unlock')).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Use your recovery key.']));
    expect(pageReads().map(([, route]) => route)).toEqual(['setup?forgot=1']);
    await act(async () => byId(tree, 'ui-forgot-back')[0].props.onPress());
    await settle();
    expect(byId(tree, 'vault-unlock')).toHaveLength(1);
    expect(texts(tree)).not.toContain('Use your recovery key.');
    act(() => tree.unmount());
    mounted.splice(0);
    await settle();
    expect(mockClient.post).toHaveBeenCalledWith('/api/satellites/Safe/lock', {}); // locked again: it locks on leaving
  });

  it('without the store on this server, it says so and shows nothing', async () => {
    __mocks.providers.mockResolvedValue({});
    const {tree} = await mount();
    expect(texts(tree).join(' ')).toMatch(/kept locked by media\.vault/);
    expect(pageReads()).toEqual([]);
  });
});
