import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Image, Modal, NativeModules, Pressable, Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';

// The Locked Folder's real ui.json (UI contract 1.2, a protected preview) on the app's shared
// screen: behind the vault's own status, its grid of tiles over its own routes - a picture from
// memory, a file with its icon and nothing fetched - and a viewer whose actions are the
// document's, "Move to Photos" only for what Photos can take. Not set up, its setup page.

declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};
const DOCUMENT = JSON.parse(readFileSync(join(__dirname, '..', '..', 'satellites', 'native', 'locked_folder', 'ui.json'), 'utf-8'));
const NAME = 'LockedFolder';

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

const VAULT = {satellite: NAME, version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', keep: 'keep'}};
const OPEN = {configured: true, pin_set: true, unlocked: true, expires_at: 'later'};
const NO_PIN = {configured: true, pin_set: false, unlocked: false, expires_at: null};

const PICTURE = {
  name: 'beach.png', path: 'trips/beach.png', folder: 'trips', size: 2048, modified: '2026-11-02T10:00:00Z',
  kind: 'image', preview: 'file', icon: null, group: 'November 2026', movable: true,
};
const NOTE = {
  name: 'secret.txt', path: 'secret.txt', folder: '', size: 3, modified: '2026-10-01T10:00:00Z',
  kind: null, preview: null, icon: 'file', group: 'October 2026', movable: false,
};
const GALLERY = {items: [PICTURE, NOTE], next: null, summary: '2 items', truncated: false, photos_available: true};
const SETUP = {title: 'No PIN yet', message: 'Set a PIN in the Locked Folder’s settings to use it.', problem: null};

let status: any;
const mounted: ReturnType<typeof renderer.create>[] = [];
async function mount() {
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={{params: {name: NAME, revision: 'r'}} as any} />);
  });
  mounted.push(tree);
  await settle();
  return tree;
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
const tiles = (tree: any) =>
  tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'));
const pageReads = () => __mocks.read.mock.calls.filter(([, route]) => route !== 'status').map(([, route]) => route);

describe('the Locked Folder’s shared interface on the app', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.clear();
    Object.values(__mocks).forEach(mock => mock.mockReset());
    mockClient.get.mockReset();
    mockClient.post.mockReset();
    status = OPEN;
    mockClient.get.mockImplementation(async (path: string) =>
      path === `/api/satellites/${NAME}/status` ? {status: 200, body: status} : {status: 404, body: {}});
    mockClient.post.mockImplementation(async (path: string) =>
      path === `/api/satellites/${NAME}/keep` ? {status: 200, body: {expires_at: 'later'}} : {status: 200, body: {}});
    (NativeModules as any).StarCoreFiles = {canSave: true, canShare: true, canOpen: true, canUpload: true};
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'r', offline: false});
    __mocks.providers.mockResolvedValue({'media.vault': [VAULT]});
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route.startsWith('gallery')) {
        return GALLERY;
      }
      return route === 'setup' ? SETUP : {};
    });
    (globalThis as any).fetch = jest.fn(async () => ({ok: true, status: 200, blob: async () => 'BYTES'}));
    (globalThis as any).FileReader = class {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:image/png;base64,QUJD';
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

  it('draws its grid from its own gallery view: a picture from memory, a file with its icon', async () => {
    const tree = await mount();
    expect(pageReads()).toEqual(['gallery?limit=120']);
    expect(texts(tree)).toEqual(expect.arrayContaining(['2 items', 'Add files']));
    expect(tiles(tree)).toHaveLength(2);
    // only the picture's preview is fetched, by its own route; the file's preview is null, so
    // its tile route is unsafe and nothing is asked for it
    const fetched = (globalThis as any).fetch.mock.calls.map(([url]: [string]) => url);
    expect(fetched).toEqual([`https://s.test/api/satellites/${NAME}/media/file?path=trips%2Fbeach.png`]);
    const sources = tree.root.findAllByType(Image).map((node: any) => node.props.source?.uri).filter(Boolean);
    expect(sources.every((uri: string) => uri.startsWith('data:'))).toBe(true);
  });

  it('opens the viewer with the document’s facts, and moves to Photos only what Photos can take', async () => {
    const tree = await mount();
    const labels = () =>
      tree.root.findByType(Modal).findAll((node: any) => node.props.accessibilityRole === 'button')
        .map((node: any) => node.props.accessibilityLabel);

    act(() => tiles(tree)[0].props.onPress());
    await settle();
    expect(labels()).toEqual(expect.arrayContaining(['Move to Photos', 'Download', 'Delete forever']));
    expect(texts({root: tree.root.findByType(Modal)})).toEqual(expect.arrayContaining(['beach.png', '1 of 2']));
  });

  it('a file Photos can’t take has no Move to Photos', async () => {
    const tree = await mount();
    act(() => tiles(tree)[1].props.onPress());
    await settle();
    const labels = tree.root.findByType(Modal).findAll((node: any) => node.props.accessibilityRole === 'button')
      .map((node: any) => node.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(['Download', 'Delete forever']));
    expect(labels).not.toContain('Move to Photos');
  });

  it('not set up, it shows its setup page and reads nothing of the vault', async () => {
    status = NO_PIN;
    const tree = await mount();
    expect(texts(tree)).toEqual(expect.arrayContaining(['No PIN yet', SETUP.message]));
    expect(pageReads()).toEqual(['setup']);
  });
});
