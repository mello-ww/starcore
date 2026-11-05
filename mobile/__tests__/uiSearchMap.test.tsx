import React from 'react';
import {Modal, Text, TextInput} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {clusterPoints, coordinates, regionFor, zoomFor} from '../src/satellites/ui/MapBlock';
import type {UiBlock} from '../src/satellites/ui/contract';

// react-native-maps' native views have nothing to run under Node: plain views stand in
jest.mock('react-native-maps', () => {
  const ReactActual = require('react');
  const {View} = require('react-native');
  const MapView = ({children, ...props}: any) => ReactActual.createElement(View, {...props, testID: 'map-view'}, children);
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
    setEditing: jest.fn(),
    mediaSource: route => ({uri: `https://server.test/api/satellites/Any/${route}`}),
    pageState: {q: ''},
    setPageState: jest.fn(),
    ...overrides,
  };
}

function render(blocks: UiBlock[], data: any, ctx: BlockContext) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data, page: data, params: {}, state: ctx.pageState}} context={ctx} />);
  });
  return tree;
}

describe('the search block', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sets its page state a moment after typing stops, trimmed', () => {
    const ctx = context();
    const tree = render([{type: 'search', key: 'q', placeholder: 'Find'}], {}, ctx);
    const input = tree.root.findByType(TextInput);
    expect(input.props.placeholder).toBe('Find');
    act(() => input.props.onChangeText('ca'));
    act(() => input.props.onChangeText('cat '));
    expect(ctx.setPageState).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(300));
    expect(ctx.setPageState).toHaveBeenCalledTimes(1);
    expect(ctx.setPageState).toHaveBeenCalledWith('q', 'cat');
  });

  it('searches at once on submit, and holds refreshes while focused', () => {
    const ctx = context({pageState: {q: 'old'}});
    const tree = render([{type: 'search', key: 'q'}], {}, ctx);
    const input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('old');
    act(() => input.props.onFocus());
    expect(ctx.setEditing).toHaveBeenCalledWith(true);
    act(() => input.props.onChangeText('dog'));
    act(() => input.props.onSubmitEditing());
    expect(ctx.setPageState).toHaveBeenCalledWith('q', 'dog');
  });
});

describe('the map block', () => {
  const block: UiBlock = {
    type: 'map', items: '$.items', empty: 'Nothing located.',
    item: {lat: '$.lat', lon: '$.lon', key: '$.id', image: 'thumbs/{$.id}', title: '$.name'},
    viewer: {image: 'full/{$.id}', title: '$.name'},
  };
  const items = [
    {id: 'a', name: 'Louvre', lat: 48.8606, lon: 2.3376},
    {id: 'b', name: 'Eiffel', lat: 48.8584, lon: 2.2945},
    {id: 'c', name: 'Nowhere', lat: null, lon: null},
    {id: 'd', name: 'London', lat: 51.5072, lon: -0.1276},
  ];

  const markers = (tree: ReturnType<typeof renderer.create>) =>
    tree.root.findAll((node: any) => node.type?.name === 'Marker').map((node: any) => node.props.testID).sort();
  const zoomOut = (tree: ReturnType<typeof renderer.create>) =>
    act(() => tree.root.find((node: any) => node.type?.name === 'MapView').props.onRegionChangeComplete({
      latitude: 50, longitude: 1, latitudeDelta: 90, longitudeDelta: 180,
    }));

  it('places only located items, as markers that cluster when zoomed out', () => {
    const tree = render([block], {items}, context());
    // fitted to the three located items: the two in Paris share a marker, London has its own
    expect(markers(tree)).toEqual(['map-marker-1', 'map-marker-2']);
    zoomOut(tree);
    expect(markers(tree)).toEqual(['map-marker-1', 'map-marker-2']);
    // zoomed into the city, the Paris items separate
    act(() => tree.root.find((node: any) => node.type?.name === 'MapView').props.onRegionChangeComplete({
      latitude: 48.86, longitude: 2.32, latitudeDelta: 0.01, longitudeDelta: 0.01,
    }));
    expect(markers(tree)).toEqual(['map-marker-1', 'map-marker-1', 'map-marker-1']);
  });

  it('opens the shared viewer on a marker’s items', () => {
    const tree = render([block], {items}, context());
    zoomOut(tree);
    const paris = tree.root.find((node: any) => node.type?.name === 'Marker' && node.props.testID === 'map-marker-2');
    act(() => paris.props.onPress());
    const viewer = tree.root.findByType(Modal);
    expect(viewer.findAllByType(Text).map((node: any) => node.props.children)).toEqual(expect.arrayContaining(['Louvre', '1 of 2']));
  });

  it('says what its empty text says when nothing has a location', () => {
    const tree = render([block], {items: [items[2]]}, context());
    expect(tree.root.findByType(Text).props.children).toBe('Nothing located.');
  });
});

describe('map helpers', () => {
  it('accepts real coordinates only, and clusters like the web', () => {
    expect(coordinates('48.1', 2)).toEqual([48.1, 2]);
    expect(coordinates(null, 2)).toBeNull();
    expect(coordinates(95, 2)).toBeNull();
    const points = [{lat: 48.8566, lon: 2.3522}, {lat: 48.8584, lon: 2.2945}, {lat: 51.5072, lon: -0.1276}];
    expect(clusterPoints(points, 1).map(cluster => cluster.points.length).sort()).toEqual([1, 2]);
    expect(clusterPoints(points, 15)).toHaveLength(3);
    expect(Math.round(zoomFor(360))).toBe(0);
    const region = regionFor(points);
    expect(region.latitude).toBeCloseTo(50.18, 1);
  });
});
