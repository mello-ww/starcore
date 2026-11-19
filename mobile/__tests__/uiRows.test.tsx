import React from 'react';
import {FlatList, Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {createListPaging} from '../src/satellites/ui/listPaging';
import {isPlayingRow, mergeItem, rowMenu, rowQuick, runsHere} from '../src/satellites/ui/rows';
import {pageEntries} from '../src/satellites/ui/VirtualListPage';
import type {UiBlock} from '../src/satellites/ui/contract';

// a menu is a sheet in a Modal, laid out inside the modal window's own safe area
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaProvider: ({children}: {children: React.ReactNode}) => React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
  };
});

// A row's own actions (UI contract 1.2 `quick`, `menu`, `then: "update"`, `item.audio`) and a
// shelf (`layout: "row"`): the same rules as Mission Control's (mission_control/tests/rows.test.mjs),
// then the blocks on screen.

const block: UiBlock = {
  type: 'media-list', items: '$.tracks',
  item: {title: '$.title', key: '$.id', audio: '$.id', group: '$.disc', format: {group: 'text'}},
  action: {play: {tracks: '$page.tracks', start: '$.id'}},
  quick: [
    {label: 'Like', icon: 'heart', visible: '$.not_liked', action: {route: 'favorites/{$.id}', method: 'POST', then: 'update'}},
    {label: 'Unlike', icon: 'heart', style: 'primary', visible: '$.liked', action: {route: 'favorites/{$.id}', method: 'POST', then: 'update'}},
  ],
  menu: [
    {label: 'Play next', action: {play: {tracks: ['$'], queue: 'next'}}},
    {label: 'Go to album', visible: '$.album_id', action: {navigate: 'album', params: {id: '$.album_id'}}},
    {label: 'Share', action: {share: 'tracks/{$.id}/file'}},
    {label: 'Open in the old page', action: {own: 'track'}},
  ],
};

const scopeOf = (data: any) => ({data, page: {}, params: {}, state: {}});

function context(overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    canRun: action => action?.share === undefined,
    ...overrides,
  };
}

function render(blocks: UiBlock[], data: any, ctx: BlockContext) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data, page: data, params: {}, state: {}}} context={ctx} />);
  });
  return tree;
}

/** The pressables with this testID (not the views they draw). */
const pressables = (tree: ReturnType<typeof renderer.create>, testID: string) =>
  tree.root.findAll((node: any) => node.type === Pressable && node.props.testID === testID);

const texts = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map((node: any) => node.props.children).flat();

describe('a row’s own actions', () => {
  it('draws one heart of a pair, and the answer’s item turns it over', () => {
    const row = {id: 't1', liked: false, not_liked: true};
    expect(rowQuick(block, scopeOf(row)).map(entry => entry.label)).toEqual(['Like']);
    expect(mergeItem(row, {item: {liked: true, not_liked: false}})).toBe(true);
    expect(rowQuick(block, scopeOf(row)).map(entry => entry.label)).toEqual(['Unlike']);
    expect(row.id).toBe('t1');
  });

  it('merges nothing from an answer without an item object', () => {
    const row = {id: 't1', liked: false};
    for (const answer of [null, {}, {item: null}, {item: [1]}, {item: 'liked'}]) {
      expect(mergeItem(row, answer)).toBe(false);
    }
    expect(row).toEqual({id: 't1', liked: false});
  });

  it('leaves out of a menu what is hidden and what this app can’t run', () => {
    const runs = (action: any) => runsHere(action, context());
    expect(rowMenu(block, scopeOf({id: 't1', album_id: 'a1'}), runs).map(entry => entry.label)).toEqual(['Play next', 'Go to album']);
    expect(rowMenu(block, scopeOf({id: 't2'}), runs).map(entry => entry.label)).toEqual(['Play next']);
    const withOwn = (action: any) => runsHere(action, context({hasOwnScreens: true, canRun: () => true}));
    expect(rowMenu(block, scopeOf({id: 't2'}), withOwn).map(entry => entry.label)).toEqual(['Play next', 'Share', 'Open in the old page']);
  });

  it('marks the row whose audio binding is the track playing now', () => {
    expect(isPlayingRow(block, scopeOf({id: 7}), '7')).toBe(true);
    expect(isPlayingRow(block, scopeOf({id: 't2'}), 't1')).toBe(false);
    expect(isPlayingRow(block, scopeOf({id: 't1'}), null)).toBe(false);
  });
});

describe('a media-list row on screen', () => {
  const data = () => ({
    tracks: [
      {id: 't1', title: 'One', disc: 'Disc 1', liked: false, not_liked: true, album_id: 'a1'},
      {id: 't2', title: 'Two', disc: 'Disc 1', liked: true, not_liked: false},
      {id: 't3', title: 'Three', disc: 'Disc 2', liked: false, not_liked: true},
    ],
  });

  it('heads each group, and a heart pair is one toggle the answer turns over in place', async () => {
    const page = data();
    const runAction = jest.fn(async (action: any, scope: any, _value?: unknown, options?: {update?: () => void}) => {
      if (action.then === 'update' && mergeItem(scope.data, {item: {liked: true, not_liked: false}})) {
        options?.update?.();
      }
      return true;
    });
    const tree = render([block], page, context({runAction}));
    expect(texts(tree)).toEqual(expect.arrayContaining(['Disc 1', 'Disc 2']));
    expect(texts(tree).filter((text: unknown) => text === 'Disc 1')).toHaveLength(1);
    expect(pressables(tree, 'media-row-quick')).toHaveLength(2);
    expect(pressables(tree, 'media-row-quick-on')).toHaveLength(1);
    const like = pressables(tree, 'media-row-quick')[0];
    await act(async () => {
      like.props.onPress();
    });
    expect(runAction).toHaveBeenCalledWith(block.quick[0].action, expect.objectContaining({data: page.tracks[0]}), undefined,
      expect.objectContaining({update: expect.any(Function)}));
    expect(page.tracks[0].liked).toBe(true);
    expect(pressables(tree, 'media-row-quick-on')).toHaveLength(2);
  });

  it('opens a menu of what this app can run, and runs the entry chosen on that row', async () => {
    const runAction = jest.fn(async () => true);
    const tree = render([block], data(), context({runAction}));
    const more = pressables(tree, 'media-row-more');
    expect(more).toHaveLength(3);
    act(() => more[0].props.onPress());
    const menu = tree.root.findByProps({testID: 'row-menu'});
    const labels = menu.findAllByType(Text).map((node: any) => node.props.children);
    expect(labels).toEqual(['Play next', 'Go to album']);
    await act(async () => {
      menu.find((node: any) => node.type === Pressable && node.props.testID === 'row-menu-1').props.onPress();
    });
    expect(runAction).toHaveBeenCalledWith(block.menu[1].action, expect.objectContaining({data: expect.objectContaining({id: 't1'})}),
      undefined, expect.anything());
    expect(tree.root.findAllByProps({testID: 'row-menu'})).toHaveLength(0);
  });

  it('a long press opens the same menu; a row with nothing left to offer has none', () => {
    const tree = render([block], data(), context());
    const row = pressables(tree, 'media-row')[0];
    act(() => row.props.onLongPress());
    expect(tree.root.findByProps({testID: 'row-menu'})).toBeTruthy();

    const bare = render([{...block, menu: [block.menu[2]]}], data(), context({canRun: () => false}));
    expect(pressables(bare, 'media-row-more')).toHaveLength(0);
    expect(pressables(bare, 'media-row')).toHaveLength(0); // its play can't run here either: a plain row
  });
});

describe('a paged media-list', () => {
  const paged: UiBlock = {...block, more: {route: 'library?tab=liked&cursor={$value}', cursor: '$.cursor'}};

  it('keeps each row’s key across pages and never shows a key twice', async () => {
    const load = jest.fn(async () => ({tracks: [{id: 't2', title: 'Two again'}, {id: 't3', title: 'Three'}], cursor: null}));
    const paging = createListPaging({load});
    const scope = {data: {tracks: [{id: 't1', title: 'One'}, {id: 't2', title: 'Two'}], cursor: 'c1'}, page: {}, params: {}, state: {}};
    scope.page = scope.data;
    const ctx = context();
    const before = pageEntries([paged], scope, ctx, paging).filter(entry => entry.kind === 'row').map(entry => entry.key);
    await paging.loadMore(paged);
    const after = pageEntries([paged], scope, ctx, paging).filter(entry => entry.kind === 'row').map(entry => entry.key);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(3);
    expect(paging.rows(paged, scope).map(row => row.title)).toEqual(['One', 'Two', 'Three']);
  });
});

describe('a shelf', () => {
  it('is one row of tiles that scrolls sideways, with a tile’s menu on a long press', () => {
    const shelf: UiBlock = {
      type: 'media-grid', layout: 'row', items: '$.albums', size: 'medium',
      item: {title: '$.title', key: '$.id', image: 'art/{$.id}'},
      action: {navigate: 'album', params: {id: '$.id'}},
      menu: [{label: 'Play', action: {play: {route: 'albums/{$.id}/tracks'}}}],
    };
    const runAction = jest.fn(async () => true);
    const tree = render([shelf], {albums: [{id: 'a1', title: 'First'}, {id: 'a2', title: 'Second'}]}, context({
      runAction,
      mediaSource: route => ({uri: `https://server.test/${route}`}),
    }));
    const list = tree.root.findByProps({testID: 'media-shelf'}).findByType(FlatList);
    expect(list.props.horizontal).toBe(true);
    expect(list.props.snapToInterval).toBeGreaterThan(0);
    const tile = pressables(tree, 'media-tile-a1')[0];
    act(() => tile.props.onLongPress());
    const menu = tree.root.findByProps({testID: 'row-menu'});
    expect(menu.findAllByType(Text).map((node: any) => node.props.children)).toEqual(['Play']);
  });
});
