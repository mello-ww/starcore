import React from 'react';
import {Linking, Modal, Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {resolveLink, type UiBlock} from '../src/satellites/ui/contract';

// a selection's whole page and page-dependent actions, a viewer field's link and a provider
// cluster's preview (UI contract 1.2, change 15)
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

function context(overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    mediaSource: route => ({uri: `https://server.test/${route}`}),
    setOverlay: jest.fn(),
    ...overrides,
  };
}

function mount(block: UiBlock, data: any, ctx: BlockContext) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={[block]} scope={{data, page: data, params: {}}} context={ctx} />);
  });
  return tree;
}

const labels = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map((node: any) => node.props.children);

describe('a media-grid selection', () => {
  const grid: UiBlock = {
    type: 'media-grid', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'},
    selection: {
      actions: [
        {label: 'Remove', visible: '$.editable', action: {route: 'remove/{$.id}', then: 'refresh'}},
        {label: 'Delete', action: {route: 'delete/{$.id}', then: 'refresh'}},
      ],
    },
  };
  const bar = (ctx: BlockContext) => {
    const shown = (ctx.setOverlay as jest.Mock).mock.calls.filter(call => call[0]).pop()[0];
    let overlay!: ReturnType<typeof renderer.create>;
    act(() => {
      overlay = renderer.create(shown);
    });
    return overlay;
  };
  const pill = (overlay: ReturnType<typeof renderer.create>, label: string) =>
    overlay.root.findAll((node: any) => node.props.accessibilityLabel === label && node.props.onPress);

  it('selects every item loaded, and offers an action only where the page allows it', async () => {
    const ctx = context();
    const data = {items: [{id: 'a'}, {id: 'b'}, {id: 'c'}], editable: false};
    const tree = mount(grid, data, ctx);
    const tile = tree.root.find((node: any) => node.type === Pressable && node.props.testID === 'media-tile-a');
    act(() => tile.props.onLongPress());
    let overlay = bar(ctx);
    expect(pill(overlay, 'Remove')).toHaveLength(0);
    act(() => pill(overlay, 'Select all')[0].props.onPress());
    overlay = bar(ctx);
    expect(labels(overlay)).toContain('3 selected');
    expect(pill(overlay, 'Select all')).toHaveLength(0);
    await act(async () => pill(overlay, 'Delete')[0].props.onPress());
    expect((ctx.runAction as jest.Mock).mock.calls.map(call => call[1].data.id)).toEqual(['a', 'b', 'c']);

    const owner = context();
    const mine = mount(grid, {...data, editable: true}, owner);
    act(() => mine.root.find((node: any) => node.type === Pressable && node.props.testID === 'media-tile-a').props.onLongPress());
    expect(pill(bar(owner), 'Remove').length).toBeGreaterThan(0);
  });
});

describe('a viewer field link', () => {
  it('stays on the host its template wrote, its bindings encoded', () => {
    const template = 'https://maps.example.org/?mlat={$.lat}&mlon={$.lon}';
    expect(resolveLink(template, {data: {lat: 48.5, lon: 2}})).toBe('https://maps.example.org/?mlat=48.5&mlon=2');
    expect(resolveLink(template, {data: {lat: '1&x=@evil.example', lon: 2}})).toBe(
      'https://maps.example.org/?mlat=1%26x%3D%40evil.example&mlon=2',
    );
    expect(resolveLink('{$.url}', {data: {url: 'https://evil.example/'}})).toBeNull();
    expect(resolveLink('javascript:alert(1)//x/', {data: {}})).toBeNull();
    expect(resolveLink('https://evil.example\\@maps.example.org/', {data: {}})).toBeNull();
  });

  it('opens in the browser from the viewer’s details', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const block: UiBlock = {
      type: 'media-grid', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'},
      viewer: {
        title: '$.id',
        fields: [{label: 'Location', value: '$.place', href: 'https://maps.example.org/?mlat={$.lat}&mlon={$.lon}'}],
      },
    };
    const tree = mount(block, {items: [{id: 'a', place: 'Paris', lat: 48.85, lon: 2.35}]}, context());
    act(() => tree.root.find((node: any) => node.type === Pressable && node.props.testID === 'media-tile-a').props.onPress());
    const viewer = tree.root.findByType(Modal);
    act(() => viewer.find((node: any) => node.props.accessibilityLabel === 'Show details' && node.props.onPress).props.onPress());
    const link = viewer.find((node: any) => node.type === Text && node.props.accessibilityRole === 'link');
    expect(link.props.children).toBe('Paris');
    act(() => link.props.onPress());
    expect(open).toHaveBeenCalledWith('https://maps.example.org/?mlat=48.85&mlon=2.35');
    open.mockRestore();
  });

  it('shows its path in its folder, and the viewer gives way to that page (change 18)', async () => {
    const block: UiBlock = {
      type: 'media-grid', items: '$.items', item: {image: 'thumbs/{$.id}', key: '$.id'},
      viewer: {title: '$.id', fields: [{label: 'Folder', value: '$.folder', action: {locate: '$.folder'}}]},
    };
    const ctx = context();
    const tree = mount(block, {items: [{id: 'a', folder: '/photos/Holiday'}]}, ctx);
    act(() => tree.root.find((node: any) => node.type === Pressable && node.props.testID === 'media-tile-a').props.onPress());
    const viewer = tree.root.findByType(Modal);
    act(() => viewer.find((node: any) => node.props.accessibilityLabel === 'Show details' && node.props.onPress).props.onPress());
    const link = viewer.find((node: any) => node.type === Text && node.props.accessibilityRole === 'link');
    expect(link.props.children).toBe('/photos/Holiday');
    await act(async () => link.props.onPress());
    expect((ctx.runAction as jest.Mock).mock.calls[0][0]).toEqual({locate: '$.folder'});
    expect((ctx.runAction as jest.Mock).mock.calls[0][1].data.folder).toBe('/photos/Holiday');
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  });
});

describe('a provider cluster with a preview', () => {
  const block: UiBlock = {
    type: 'map', items: '$.items', bounds: '$.bounds',
    item: {lat: '$.lat', lon: '$.lon', key: '$.id', count: '$.count', bounds: '$.area', title: '$.id', image: 'thumbs/{$.id}'},
    viewport: {route: 'located?bbox={$value.bbox}&zoom={$value.zoom}', preview: 'located?bbox={$value.bbox}&preview=12'},
    viewer: {title: '$.id'},
  };

  it('opens the viewer on its newest items', async () => {
    const load = jest.fn(async (route: string) =>
      route.includes('preview=')
        ? {items: [{id: 'p1', lat: 48.86, lon: 2.34, count: 1}, {id: 'p2', lat: 48.87, lon: 2.36, count: 1}]}
        : {items: [{id: 'cluster', lat: 48.85, lon: 2.35, count: 40, area: [48.8, 2.3, 48.9, 2.4]}]},
    );
    const data = {items: [], bounds: [45, 2, 49, 5]};
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<UiBlocks blocks={[block]} scope={{data, page: data, params: {}}} context={context({load})} />);
    });
    const cluster = tree.root.find((node: any) => node.type?.name === 'Marker' && node.props.testID === 'map-marker-40');
    await act(async () => cluster.props.onPress());
    expect(load).toHaveBeenLastCalledWith('located?bbox=48.8%2C2.3%2C48.9%2C2.4&preview=12');
    const viewer = tree.root.findByType(Modal);
    expect(viewer.findAllByType(Text).map((node: any) => node.props.children)).toEqual(expect.arrayContaining(['p1', '1 of 2']));
  });
});
