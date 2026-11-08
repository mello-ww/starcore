import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {FlatList, Pressable, RefreshControl, Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {ApiError} from '../src/api/types';
import {OFFLINE_PREFIX} from '../src/satellites/ui/offline';

jest.mock('../src/auth/AuthContext', () => ({
  useAuth: jest.fn(() => ({client: {}, state: {status: 'signed-in', session: {token: 'session-one'}}})),
}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1', baseUrl: 'https://s.test'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {
  __mocks: {document: jest.Mock; providers: jest.Mock; read: jest.Mock; act: jest.Mock};
};

// an offline page (UI contract 1.2) on Android: kept while live, shown while StarCore can't be
// reached, never for a refused session, and forgotten after anything changes

const grid = (id: string) => ({
  type: 'media-grid', id, items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id', title: '$.name'},
  more: {route: 'items?limit=2&cursor={$value}', cursor: '$.next'},
  viewer: {image: 'full/{$.id}', actions: [{label: 'Bin', action: {route: 'trash/{$.id}', then: 'refresh'}}]},
});
const DOCUMENT = {
  contract: 'starcore.ui/1.2', title: 'Pics', entry: 'library',
  pages: {
    library: {offline: true, source: {route: 'items?limit=2'}, blocks: [grid('library')]},
    elsewhere: {source: {route: 'other'}, blocks: [{type: 'text', text: '$.note'}]},
  },
};
const FIRST = {items: [{id: 'p1', name: 'One'}, {id: 'p2', name: 'Two'}], next: 'c1'};
const SECOND = {items: [{id: 'p3', name: 'Three'}], next: null};
const offline = () => Promise.reject(new ApiError('Could not reach StarCore.', 0));

const mounted: ReturnType<typeof renderer.create>[] = [];
async function mount(page?: string) {
  let tree!: ReturnType<typeof renderer.create>;
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={{params: {name: 'Pics', revision: 'r', page}} as any} />);
  });
  mounted.push(tree);
  return tree;
}
const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));
const texts = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
const tiles = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-')).length;
const kept = async () => (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(OFFLINE_PREFIX) && !key.includes(':index:'));

async function loadNextPage(tree: ReturnType<typeof renderer.create>) {
  const list = tree.root.findAllByType(FlatList).find((node: any) => node.props.testID === 'media-grid-list')!;
  await act(async () => {
    list.props.onEndReached();
  });
  await settle();
}

describe('an offline page', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    Object.values(__mocks).forEach(mock => mock.mockReset());
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'r', offline: false});
    __mocks.providers.mockResolvedValue({});
    __mocks.read.mockImplementation(async (_s: string, route: string) =>
      route === 'items?limit=2' ? FIRST : route.startsWith('items?limit=2&cursor=c1') ? SECOND : {note: 'hi'});
    __mocks.act.mockResolvedValue({});
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
  });

  it('is kept while live, with the grid pages loaded after it, and shown, marked, while StarCore can’t be reached', async () => {
    const live = await mount();
    await settle();
    await loadNextPage(live);
    expect(tiles(live)).toBe(3);
    expect(await kept()).toHaveLength(1);
    const stored = JSON.parse((await AsyncStorage.getItem((await kept())[0]))!);
    expect(JSON.stringify(stored)).not.toContain('session-one'); // never the token
    expect(JSON.stringify(stored)).not.toContain('https://'); // nor a resolved URL

    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
    __mocks.read.mockImplementation(offline);
    const away = await mount();
    await settle();
    expect(tiles(away)).toBe(3); // the page data and the page after it, in order
    expect(texts(away)).toEqual(expect.arrayContaining(['Offline']));

    // StarCore answers again: the page is live once more
    __mocks.read.mockImplementation(async (_s: string, route: string) => (route === 'items?limit=2' ? {...FIRST, next: null} : SECOND));
    await act(async () => {
      await away.root.findByType(RefreshControl).props.onRefresh();
    });
    await settle();
    expect(texts(away)).not.toContain('Offline');
    expect(tiles(away)).toBe(2);
  });

  it('is never shown for a session the server refused - everything kept for the server goes', async () => {
    const live = await mount();
    await settle();
    expect(await kept()).toHaveLength(1);
    __mocks.read.mockRejectedValue(new ApiError('Not signed in.', 401));
    await act(async () => {
      await live.root.findByType(RefreshControl).props.onRefresh();
    });
    await settle();
    expect(await kept()).toHaveLength(0);
  });

  it('is forgotten when an action changes something on the server', async () => {
    const live = await mount();
    await settle();
    expect(await kept()).toHaveLength(1);
    __mocks.read.mockImplementation(offline); // the refresh after it can't reach StarCore
    const tile = live.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'))[0];
    await act(async () => tile.props.onPress());
    const bin = live.root.findAll((node: any) => node.type === Pressable && texts({root: node} as any).includes('Bin'))[0];
    await act(async () => bin.props.onPress());
    await settle();
    expect(__mocks.act).toHaveBeenCalled();
    expect(await kept()).toHaveLength(0); // so an item that left can't come back offline
  });

  it('keeps only the fields the page binds, and never one it omits', async () => {
    __mocks.document.mockResolvedValue({
      document: {...DOCUMENT, pages: {...DOCUMENT.pages, library: {...DOCUMENT.pages.library, offline: {omit: ['location']},
        blocks: [{...grid('library'), viewer: {...grid('library').viewer, fields: [{label: 'Place', value: '$.location'}]}}]}}},
      revision: 'r', offline: false,
    });
    __mocks.read.mockImplementation(async (_s: string, route: string) =>
      route === 'items?limit=2'
        ? {items: [{id: 'p1', name: 'One', location: '49.1, 6.2', path: '/srv/a.jpg'}], next: null, owner: 'x'}
        : {note: 'hi'});
    const live = await mount();
    await settle();
    expect(tiles(live)).toBe(1);
    const stored = (await AsyncStorage.getItem((await kept())[0]))!;
    expect(JSON.parse(stored).data).toEqual({items: [{id: 'p1', name: 'One'}], next: null});

    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
    __mocks.read.mockImplementation(offline);
    const away = await mount();
    await settle();
    expect(tiles(away)).toBe(1); // still shown offline, by what was kept
  });

  it('keeps nothing for a page that doesn’t ask for it', async () => {
    await mount('elsewhere');
    await settle();
    expect(await kept()).toHaveLength(0);
  });

  it('shows nothing kept by another session', async () => {
    const live = await mount();
    await settle();
    expect(await kept()).toHaveLength(1);
    act(() => live.unmount());
    const {useAuth} = jest.requireMock('../src/auth/AuthContext');
    useAuth.mockReturnValue({client: {}, state: {status: 'signed-in', session: {token: 'session-two'}}});
    __mocks.read.mockImplementation(offline);
    const other = await mount();
    await settle();
    expect(tiles(other)).toBe(0);
    useAuth.mockReturnValue({client: {}, state: {status: 'signed-in', session: {token: 'session-one'}}});
  });
});
