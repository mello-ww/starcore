import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert, Pressable, Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {OFFLINE_PREFIX} from '../src/satellites/ui/offline';

// The secure action (UI contract 1.2) on the app's shared screen: the viewer's and a selection's
// "Move to the vault" run once, through the app's own prompt for the provider (a grant, never a
// PIN through shared code), then forget the moved items - offline copies for every session and
// their images in the cache. Without a provider or a prompt, the control isn't there.

jest.mock('../src/auth/AuthContext', () => ({
  useAuth: jest.fn(() => ({client: {}, state: {status: 'signed-in', session: {token: 'session-one'}}})),
}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1', baseUrl: 'https://s.test'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/platform/privacy', () => ({privacy: {evictImages: jest.fn(), setSecure: jest.fn()}}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});
// the app's own prompt for media.vault, as the composition root registers it: grants at once
jest.mock('../src/satellites/builtins', () => {
  const prompt = {
    capability: 'media.vault',
    satellite: 'Vault',
    component: jest.fn(({wanted, onGrant}: any) => {
      const {useEffect: effect} = require('react');
      effect(() => {
        onGrant(`grant-for-${wanted.items.length}`);
      }, []);
      return null;
    }),
  };
  return {BUILTIN_SECURE_PROMPTS: [prompt], __prompt: prompt};
});
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {__mocks: Record<string, jest.Mock>};
const {__prompt} = jest.requireMock('../src/satellites/builtins') as {__prompt: {component: jest.Mock}};
const {privacy} = jest.requireMock('../src/platform/privacy') as {privacy: {evictImages: jest.Mock}};

const MOVE = {secure: {capability: 'media.vault', operation: 'move_in'}, item: '$.id', confirm: 'Move it?', then: 'refresh'};
const DOCUMENT = {
  contract: 'starcore.ui/1.2', title: 'Pics', entry: 'library',
  pages: {
    library: {
      offline: true, source: {route: 'items'},
      blocks: [{
        type: 'media-grid', id: 'library', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'},
        viewer: {image: 'full/{$.id}', actions: [{label: 'Move to the vault', action: MOVE}]},
        selection: {actions: [{label: 'Lock', action: MOVE}]},
      }],
    },
  },
};
const VAULT = {satellite: 'Vault', version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', move_in: 'move_in'}};
const GALLERY = {satellite: 'Pics', version: 1, enabled: true, operations: {list: 'media', thumbnail: 'thumbs', resolve: 'media/resolve'}};
const ITEMS = {items: [{id: 'p1'}, {id: 'p2'}, {id: 'p3'}]};

const mounted: ReturnType<typeof renderer.create>[] = [];
async function mount() {
  let tree!: ReturnType<typeof renderer.create>;
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={{params: {name: 'Pics', revision: 'r'}} as any} />);
  });
  mounted.push(tree);
  await settle();
  return tree;
}
const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));
const texts = (node: any) => node.findAllByType(Text).map((text: any) => [text.props.children].flat().join(''));
const button = (tree: any, label: string) =>
  tree.root.findAll((node: any) => node.type === Pressable && node.props.accessibilityLabel === label)[0];
const tiles = (tree: any) => tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'));

describe('the secure action on the app’s shared screen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    Object.values(__mocks).forEach(mock => mock.mockReset());
    __prompt.component.mockClear();
    privacy.evictImages.mockClear();
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'r', offline: false});
    __mocks.providers.mockResolvedValue({'media.vault': [VAULT], 'media.gallery': [GALLERY]});
    __mocks.read.mockImplementation(async (satellite: string, route: string) =>
      satellite === 'Vault' && route === 'status' ? {configured: true, pin_set: true, unlocked: false} : ITEMS);
    __mocks.act.mockImplementation(async (_s: string, _r: string, _m: string, body: any) => ({
      moved: body.items.map(({id}: any) => ({id, path: `Photos/${id}.jpg`})), failed: [],
    }));
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
    jest.restoreAllMocks();
  });

  it('moves the photo on screen with a grant from the app’s own prompt, then forgets it everywhere', async () => {
    // an offline copy kept by another session, which must go too
    await AsyncStorage.setItem(`${OFFLINE_PREFIX}:srv-1:other:Pics:library`, '{}');
    const tree = await mount();
    await act(async () => tiles(tree)[0].props.onPress());
    await act(async () => button(tree, 'Move to the vault').props.onPress());
    await settle();

    expect(Alert.alert).toHaveBeenCalledWith('Move it?', undefined, expect.anything(), expect.anything());
    expect(__prompt.component).toHaveBeenCalledTimes(1);
    const reference = {provider: 'Pics', capability: 'media.gallery', id: 'p1'};
    expect(__mocks.act).toHaveBeenCalledWith('Vault', 'move_in', 'POST', {items: [reference], grant: 'grant-for-1'});
    expect(__mocks.act.mock.calls.flat().join(' ')).not.toMatch(/pin/i);
    expect(privacy.evictImages).toHaveBeenCalledWith(['https://s.test/api/satellites/Pics/thumbs/p1', 'https://s.test/api/satellites/Pics/full/p1']);
    // every session's offline copies of this Satellite are gone (the page then keeps itself afresh)
    expect((await AsyncStorage.getAllKeys()).some(key => key.includes(':other:'))).toBe(false);
    expect(texts(tree.root)).toEqual(expect.arrayContaining(['Moved 1 item.']));
  });

  it('moves a whole selection in one request, with one prompt', async () => {
    const tree = await mount();
    await act(async () => tiles(tree)[0].props.onLongPress());
    await act(async () => tiles(tree)[2].props.onPress());
    await act(async () => button(tree, 'Lock').props.onPress());
    await settle();
    expect(__prompt.component).toHaveBeenCalledTimes(1);
    expect(__mocks.act).toHaveBeenCalledTimes(1);
    expect(__mocks.act.mock.calls[0][3]).toEqual({
      items: [{provider: 'Pics', capability: 'media.gallery', id: 'p1'}, {provider: 'Pics', capability: 'media.gallery', id: 'p3'}],
      grant: 'grant-for-2',
    });
  });

  it('asks no prompt when the session already has it unlocked', async () => {
    __mocks.read.mockImplementation(async (satellite: string) =>
      satellite === 'Vault' ? {configured: true, pin_set: true, unlocked: true} : ITEMS);
    const tree = await mount();
    await act(async () => tiles(tree)[1].props.onPress());
    await act(async () => button(tree, 'Move to the vault').props.onPress());
    await settle();
    expect(__prompt.component).not.toHaveBeenCalled();
    expect(__mocks.act.mock.calls[0][3]).toEqual({items: [{provider: 'Pics', capability: 'media.gallery', id: 'p2'}]});
  });

  it('shows no control without a provider for it', async () => {
    __mocks.providers.mockResolvedValue({'media.gallery': [GALLERY]});
    const tree = await mount();
    await act(async () => tiles(tree)[0].props.onPress());
    expect(button(tree, 'Move to the vault')).toBeUndefined();
    await act(async () => tiles(tree)[0].props.onLongPress());
    expect(button(tree, 'Lock')).toBeUndefined();
  });
});
