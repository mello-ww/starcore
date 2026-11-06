import React from 'react';
import {Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {VirtualMediaGrid} from '../src/satellites/ui/MediaGrid';
import {boundsOf, viewportValue} from '../src/satellites/ui/MapBlock';
import type {UiBlock} from '../src/satellites/ui/contract';

// paging (a media-grid's `more`) and viewport maps (UI contract 1.2)
jest.mock('react-native-maps', () => {
  const ReactActual = require('react');
  const {View} = require('react-native');
  const MapView = ReactActual.forwardRef(({children, ...props}: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({animateToRegion: jest.fn()}));
    return ReactActual.createElement(View, {...props, testID: 'map-view'}, children);
  });
  const Marker = ({children, ...props}: any) => ReactActual.createElement(View, props, children);
  return {__esModule: true, default: MapView, Marker};
});

function context(load: jest.Mock, overrides: Partial<BlockContext> = {}): BlockContext & {nearEnd: () => void} {
  const listeners = new Set<() => void>();
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    mediaSource: route => ({uri: `https://server.test/${route}`}),
    load,
    onNearEnd: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOverlay: jest.fn(),
    nearEnd: () => listeners.forEach(listener => listener()),
    ...overrides,
  };
}

const grid: UiBlock = {
  type: 'media-grid', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'},
  more: {route: 'items?limit=2&cursor={$value}', cursor: '$.next'},
  selection: {actions: [{label: 'Delete', action: {route: 'delete/{$.id}', then: 'refresh'}}]},
};
const page = (ids: string[], next: string | null) => ({items: ids.map(id => ({id})), next});
const tiles = (tree: ReturnType<typeof renderer.create>) =>
  tree.root
    .findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'))
    .map((node: any) => node.props.testID.replace('media-tile-', ''));

function mount(data: any, ctx: BlockContext, block = grid) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={[block]} scope={{data, page: data, params: {}}} context={ctx} />);
  });
  return tree;
}

describe('a paged media-grid', () => {
  it('loads the next page through its cursor, without repeating an item, until the end', async () => {
    const load = jest.fn().mockResolvedValueOnce(page(['b', 'c', 'd'], 'k2')).mockResolvedValueOnce(page(['e'], null));
    const ctx = context(load);
    const tree = mount(page(['a', 'b'], 'k1'), ctx);
    expect(tiles(tree)).toEqual(['a', 'b']);
    await act(async () => ctx.nearEnd());
    expect(load).toHaveBeenCalledWith('items?limit=2&cursor=k1');
    expect(tiles(tree)).toEqual(['a', 'b', 'c', 'd']);
    await act(async () => ctx.nearEnd());
    expect(load).toHaveBeenLastCalledWith('items?limit=2&cursor=k2');
    expect(tiles(tree)).toEqual(['a', 'b', 'c', 'd', 'e']);
    await act(async () => ctx.nearEnd());
    expect(load).toHaveBeenCalledTimes(2); // the end: no cursor left
  });

  it('drops a page that arrives after the data changed', async () => {
    let finish!: (value: any) => void;
    const load = jest.fn(() => new Promise(resolve => (finish = resolve)));
    const ctx = context(load);
    const first = page(['a'], 'k1');
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<UiBlocks blocks={[grid]} scope={{data: first, page: first, params: {}}} context={ctx} />);
    });
    await act(async () => ctx.nearEnd());
    const fresh = page(['x', 'y'], null); // another filter, say: new page data
    act(() => tree.update(<UiBlocks blocks={[grid]} scope={{data: fresh, page: fresh, params: {}}} context={ctx} />));
    await act(async () => finish(page(['stale'], null)));
    expect(tiles(tree)).toEqual(['x', 'y']);
  });

  it('says when a page fails, and tries again', async () => {
    const load = jest.fn().mockRejectedValueOnce(new Error('Server busy')).mockResolvedValueOnce(page(['b'], null));
    const ctx = context(load);
    const tree = mount(page(['a'], 'k1'), ctx);
    await act(async () => ctx.nearEnd());
    expect(tree.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('Server busy');
    const retry = tree.root.find((node: any) => node.type === Pressable && node.props.accessibilityLabel === 'Try again');
    await act(async () => retry.props.onPress());
    expect(tiles(tree)).toEqual(['a', 'b']);
  });

  it('keeps a selection across pages, and runs on items of every page', async () => {
    const load = jest.fn().mockResolvedValueOnce(page(['b'], null));
    const ctx = context(load);
    const tree = mount(page(['a'], 'k1'), ctx);
    const press = (key: string) =>
      tree.root.find((node: any) => node.type === Pressable && node.props.testID === `media-tile-${key}`);
    act(() => press('a').props.onLongPress());
    await act(async () => ctx.nearEnd());
    act(() => press('b').props.onPress());
    const bar = (ctx.setOverlay as jest.Mock).mock.calls.filter(call => call[0]).pop()[0];
    let overlay!: ReturnType<typeof renderer.create>;
    act(() => {
      overlay = renderer.create(bar);
    });
    expect(overlay.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('2 selected');
    const remove = overlay.root.find((node: any) => node.props.accessibilityLabel === 'Delete' && node.props.onPress);
    await act(async () => remove.props.onPress());
    expect((ctx.runAction as jest.Mock).mock.calls.map(call => call[1].data.id)).toEqual(['a', 'b']);
  });

  it('as a page’s main content, it is a virtualized list that loads at its end', async () => {
    const load = jest.fn().mockResolvedValueOnce(page(['c'], null));
    const ctx = context(load);
    const data = page(['a', 'b'], 'k1');
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(
        <VirtualMediaGrid block={grid} scope={{data, page: data, params: {}}} context={ctx} header={<Text>Above</Text>} />,
      );
    });
    const list = tree.root.find((node: any) => node.props.testID === 'media-grid-list' && node.props.getItemLayout);
    expect(list.props.removeClippedSubviews).toBe(true);
    expect(list.props.getItemLayout(null, 0).length).toBeGreaterThan(0);
    await act(async () => list.props.onEndReached());
    expect(tiles(tree)).toEqual(['a', 'b', 'c']);
    expect(tree.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('Above');
  });
});

describe('a viewport map', () => {
  const block: UiBlock = {
    type: 'map', items: '$.items', bounds: '$.bounds',
    item: {lat: '$.lat', lon: '$.lon', key: '$.id', count: '$.count', bounds: '$.area'},
    viewport: {route: 'located?bbox={$value.bbox}&zoom={$value.zoom}'},
  };

  it('loads what is on screen and draws the provider’s clusters with their counts', async () => {
    const load = jest.fn().mockResolvedValue({
      items: [
        {id: 'cluster', lat: 48.85, lon: 2.35, count: 40, area: [48.8, 2.3, 48.9, 2.4]},
        {id: 'one', lat: 45.76, lon: 4.83, count: 1},
      ],
    });
    let tree!: ReturnType<typeof renderer.create>;
    const data = {items: [], bounds: [45, 2, 49, 5]};
    await act(async () => {
      tree = renderer.create(<UiBlocks blocks={[block]} scope={{data, page: data, params: {}}} context={context(load)} />);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toMatch(/^located\?bbox=4[0-9.]+%2C[0-9.]+%2C[0-9.]+%2C[0-9.]+&zoom=\d+$/);
    const markers = tree.root.findAll((node: any) => node.type?.name === 'Marker').map((node: any) => node.props.testID).sort();
    expect(markers).toEqual(['map-marker-1', 'map-marker-40']);
  });

  it('says what it says when nothing has a location', async () => {
    const data = {items: [], bounds: null};
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<UiBlocks blocks={[{...block, empty: 'Nothing located.'}]} scope={{data, page: data, params: {}}} context={context(jest.fn())} />);
    });
    expect(tree.root.findByType(Text).props.children).toBe('Nothing located.');
  });

  it('describes a region as the viewport value the route gets', () => {
    expect(viewportValue({latitude: 48, longitude: 2, latitudeDelta: 2, longitudeDelta: 4})).toEqual({bbox: '47,0,49,4', zoom: 6});
    expect(viewportValue({latitude: 0, longitude: 0, latitudeDelta: 170, longitudeDelta: 400}).bbox).toBe('-85,-180,85,180');
    expect(boundsOf([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(boundsOf([3, 2, 1, 4])).toBeNull();
  });
});
