import React from 'react';
import {Image, Modal, Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {clock, gridColumns, GRID_PAGE, tileAction, tileIcon} from '../src/satellites/ui/MediaGrid';
import type {UiBlock} from '../src/satellites/ui/contract';

// the media-grid block and its viewer (UI contract 1.2), with a context like the screen's:
// images come from the Satellite's own routes with the session, and actions are recorded
function context(overrides: Partial<BlockContext> = {}): BlockContext & {nearEnd: () => void} {
  const listeners = new Set<() => void>();
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    mediaSource: route => ({uri: `https://server.test/api/satellites/Any/${route}`, headers: {Authorization: 'Bearer t'}}),
    onNearEnd: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOverlay: jest.fn(),
    confirm: jest.fn(async () => true),
    afterSelection: jest.fn(),
    nearEnd: () => listeners.forEach(listener => listener()),
    ...overrides,
  };
}

function render(blocks: UiBlock[], data: any, ctx: BlockContext) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data, page: data, params: {}}} context={ctx} />);
  });
  return tree;
}

const grid: UiBlock = {
  type: 'media-grid', items: '$.items', empty: 'Nothing yet.',
  item: {image: 'thumbs/{$.id}', key: '$.id', kind: '$.kind', duration: '$.seconds', group: '$.month'},
  viewer: {
    image: 'full/{$.id}', video: 'play/{$.id}', title: '$.name',
    fields: [{label: 'Size', value: '$.bytes', format: 'bytes'}],
    actions: [
      {label: 'Favorite', visible: '$.can_favorite', action: {route: 'fav', body: {id: '$.id'}, then: 'refresh'}},
      {label: 'Delete', style: 'danger', action: {route: 'items/{$.id}/delete', then: 'refresh'}},
    ],
  },
  selection: {actions: [{label: 'Delete', action: {route: 'items/{$.id}/delete', confirm: 'Delete them?', then: 'refresh'}}]},
};

const items = (count: number) =>
  Array.from({length: count}, (_, index) => ({
    id: `p${index}`, name: `Photo ${index}`, kind: index === 1 ? 'video' : 'image', seconds: index === 1 ? 65 : null,
    month: index < 2 ? 'November 2026' : 'October 2026', bytes: 2048, can_favorite: index === 0,
  }));

const tiles = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'));

describe('the media-grid block', () => {
  it('draws thumbnails from the Satellite’s own routes, in groups, with a video badge', () => {
    const tree = render([grid], {items: items(3)}, context());
    const uris = tree.root.findAllByType(Image).map((image: any) => image.props.source.uri);
    expect(uris).toEqual([0, 1, 2].map(index => `https://server.test/api/satellites/Any/thumbs/p${index}`));
    expect(tree.root.findAllByType(Image)[0].props.source.headers).toEqual({Authorization: 'Bearer t'});
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children);
    expect(texts).toEqual(expect.arrayContaining(['November 2026', 'October 2026', '1:05']));
  });

  it('reveals a page at a time as the screen nears its end', () => {
    const ctx = context();
    const tree = render([grid], {items: items(GRID_PAGE + 5)}, ctx);
    expect(tiles(tree)).toHaveLength(GRID_PAGE);
    act(() => ctx.nearEnd());
    expect(tiles(tree)).toHaveLength(GRID_PAGE + 5);
  });

  it('says what its empty text says', () => {
    const tree = render([grid], {items: []}, context());
    expect(tree.root.findByType(Text).props.children).toBe('Nothing yet.');
  });

  it('opens the viewer with the full image, the document’s facts and its visible actions', async () => {
    const ctx = context();
    const tree = render([grid], {items: items(3)}, ctx);
    act(() => tiles(tree)[0].props.onPress());
    const viewer = tree.root.findByType(Modal);
    const sources = viewer.findAllByType(Image).map((image: any) => image.props.source.uri);
    expect(sources).toContain('https://server.test/api/satellites/Any/full/p0');
    const labels = viewer.findAll((node: any) => node.props.accessibilityRole === 'button').map((node: any) => node.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(['Close', 'Show details', 'Favorite', 'Delete']));
    const favorite = viewer.find((node: any) => node.props.accessibilityLabel === 'Favorite' && node.props.onPress);
    await act(async () => favorite.props.onPress());
    expect(ctx.runAction).toHaveBeenCalledWith(
      expect.objectContaining({route: 'fav'}), expect.objectContaining({data: expect.objectContaining({id: 'p0'})}));
  });

  it('runs a selection action on each selected item, asking once', async () => {
    const ctx = context();
    const tree = render([grid], {items: items(3)}, ctx);
    act(() => tiles(tree)[0].props.onLongPress());
    act(() => tiles(tree)[2].props.onPress());
    // the floating bar is handed to the screen; render what it was given last
    const bar = (ctx.setOverlay as jest.Mock).mock.calls.filter(call => call[0]).pop()[0];
    let overlay!: ReturnType<typeof renderer.create>;
    act(() => {
      overlay = renderer.create(bar);
    });
    expect(overlay.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('2 selected');
    const remove = overlay.root.find((node: any) => node.props.accessibilityLabel === 'Delete' && node.props.onPress);
    await act(async () => remove.props.onPress());
    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    const calls = (ctx.runAction as jest.Mock).mock.calls;
    expect(calls.map(call => call[1].data.id)).toEqual(['p0', 'p2']);
    expect(calls[0][0]).toEqual(expect.objectContaining({route: 'items/{$.id}/delete', confirm: undefined, then: undefined}));
    expect(calls[0][3]).toEqual({quiet: true});
    expect(ctx.afterSelection).toHaveBeenCalledWith('refresh', 0, 2);
  });

  it('runs the tile action when there is no viewer', () => {
    const ctx = context();
    const block: UiBlock = {type: 'media-grid', items: [{id: 'a', title: 'Album'}], item: {image: 'covers/{$.id}', title: '$.title'},
      action: {navigate: 'album', params: {id: '$.id'}}};
    const tree = render([block], {}, ctx);
    act(() => tiles(tree)[0].props.onPress());
    expect(ctx.runAction).toHaveBeenCalledWith(block.action, expect.objectContaining({data: {id: 'a', title: 'Album'}}));
    expect(tree.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('Album');
  });

  it('runs the first open entry that holds for each tile, and draws an item’s icon without an image', () => {
    const own = {own: 'locked'};
    const navigate = {navigate: 'album', params: {id: '$.id'}};
    const block: UiBlock = {type: 'media-grid', items: '$.albums', item: {image: 'covers/{$.cover}', key: '$.id', icon: '$.icon'},
      open: [{visible: '$.locked', action: own}, {action: navigate}]} as any;
    const albums = [{id: 'locked', cover: '', icon: 'lock', locked: true}, {id: 'a', cover: 'p1'}];
    const ctx = context({hasOwnScreens: true});
    const tree = render([block], {albums}, ctx);
    const icons = tree.root.findAll((node: any) => node.props.name === 'lock' && typeof node.type !== 'string');
    expect(icons.length).toBeGreaterThan(0);
    act(() => tiles(tree)[0].props.onPress());
    expect(ctx.runAction).toHaveBeenLastCalledWith(own, expect.objectContaining({data: albums[0]}));
    act(() => tiles(tree)[1].props.onPress());
    expect(ctx.runAction).toHaveBeenLastCalledWith(navigate, expect.objectContaining({data: albums[1]}));

    // without the Satellite's own screens, the own entry is skipped: that tile opens nothing
    const bare = render([{...block, open: [{visible: '$.locked', action: own}]} as any], {albums}, context({hasOwnScreens: false}));
    expect(tiles(bare)).toHaveLength(0);
  });

  it('shows the placeholder, and loads nothing, for a route outside the Satellite', () => {
    const block: UiBlock = {type: 'media-grid', items: [{id: 'x'}], item: {image: '../other/{$.id}'}};
    const tree = render([block], {}, context());
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
  });
});

describe('media-grid helpers', () => {
  it('chooses a tile’s action and icon as Mission Control does', () => {
    const all = () => true;
    const noOwn = (action: any) => action.own === undefined;
    const navigate = {navigate: 'album', params: {id: '$.id'}};
    const own = {own: 'locked'};
    expect(tileAction({action: navigate} as any, {data: {}} as any, all)).toBe(navigate);
    const block = {open: [{visible: '$.locked', action: own}, {action: navigate}]} as any;
    expect(tileAction(block, {data: {locked: true}} as any, all)).toBe(own);
    expect(tileAction(block, {data: {locked: false}} as any, all)).toBe(navigate);
    expect(tileAction(block, {data: {locked: true}} as any, noOwn)).toBe(navigate);
    expect(tileAction({open: [{visible: '$.locked', action: own}]} as any, {data: {locked: true}} as any, noOwn)).toBeNull();
    expect(tileAction({viewer: {}} as any, {data: {}} as any, all)).toBeNull();
    expect(tileIcon({item: {icon: '$.icon'}} as any, {data: {icon: 'lock'}} as any)).toBe('lock');
    expect(tileIcon({item: {icon: 'folder'}} as any, {data: {}} as any)).toBe('folder');
    expect(tileIcon({item: {icon: '$.icon'}} as any, {data: {icon: '<svg>'}} as any)).toBeNull();
    expect(tileIcon({item: {}} as any, {data: {}} as any)).toBeNull();
  });

  it('fits columns to the width and formats durations', () => {
    expect(gridColumns(360, 'medium')).toBe(3);
    expect(gridColumns(360, 'small')).toBe(4);
    expect(gridColumns(360, 'large')).toBe(2);
    expect(gridColumns(360, 'full')).toBe(1);
    expect(clock(65)).toBe('1:05');
    expect(clock(3725)).toBe('1:02:05');
  });
});
