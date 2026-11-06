import React from 'react';
import {Dimensions, FlatList, Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {
  columnRange, firstEntryFrom, gridColumns, gridPreferenceKey, rowAt, rowOfEntry, type Row,
} from '../src/satellites/ui/MediaGrid';
import {forgetUiPreferences, uiPreferences} from '../src/satellites/ui/preferences';
import {pinchedColumns} from '../src/components/pinchColumns';
import {panLimit, ZoomableImage} from '../src/components/ZoomableImage';
import type {UiBlock} from '../src/satellites/ui/contract';

// UI contract 1.2's media-grid on Android: a size the person pinches to (remembered per server,
// Satellite and grid), and a viewer whose images zoom without fighting the swipe between them

function context(overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    mediaSource: route => ({uri: `https://server.test/api/satellites/Any/${route}`}),
    setOverlay: jest.fn(),
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
  type: 'media-grid', id: 'library', items: '$.items',
  item: {image: 'thumbs/{$.id}', key: '$.id', kind: '$.kind'},
  viewer: {image: 'full/{$.id}', video: 'play/{$.id}', title: '$.name'},
};
const items = (count: number) => Array.from({length: count}, (_, index) => ({id: `p${index}`, name: `P${index}`, kind: index === 1 ? 'video' : 'image'}));

const tiles = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID ?? '').startsWith('media-tile-'));

// how many tiles the grid's first row holds: the first tile's row is the nearest view above it
// that holds more than one
const firstRow = (tree: ReturnType<typeof renderer.create>) => {
  let parent: any = tiles(tree)[0].parent;
  const count = (node: any) => node.findAll((child: any) => child.type === Pressable && String(child.props.testID ?? '').startsWith('media-tile-')).length;
  while (parent && count(parent) < 2) {
    parent = parent.parent;
  }
  return count(parent);
};
const fit = () => gridColumns(Math.min(Dimensions.get('window').width - 32, 1200), 'medium');

describe('a media-grid’s size', () => {
  beforeEach(async () => {
    forgetUiPreferences();
    await AsyncStorage.clear();
  });

  it('pinches between two and as many columns as fit at 48 dp', () => {
    expect(pinchedColumns(3, 2, 2, 6)).toBe(2); // fingers apart: fewer, bigger tiles
    expect(pinchedColumns(3, 0.5, 2, 6)).toBe(6); // together: more, smaller
    expect(pinchedColumns(4, 1.1, 2, 6)).toBe(4); // a small pinch changes nothing
    expect(pinchedColumns(4, 0, 2, 6)).toBe(4);
    expect(columnRange(358)).toEqual([2, 7]);
    expect(columnRange(1200)).toEqual([2, 12]);
    expect(columnRange(150)).toEqual([2, 4]);
  });

  it('starts at the document’s size, then at the size the person chose for this grid', () => {
    expect(firstRow(render([grid], {items: items(20)}, context({preferences: uiPreferences('srv-1', 'Any')})))).toBe(fit());
    uiPreferences('srv-1', 'Any').set(gridPreferenceKey(grid), '5');
    expect(firstRow(render([grid], {items: items(20)}, context({preferences: uiPreferences('srv-1', 'Any')})))).toBe(5);
  });

  it('keeps each choice to its own server, Satellite and grid', async () => {
    uiPreferences('srv-1', 'Any').set(gridPreferenceKey(grid), '5');
    await expect(uiPreferences('srv-1', 'Any').get(gridPreferenceKey(grid))).resolves.toBe('5');
    await expect(uiPreferences('srv-2', 'Any').get(gridPreferenceKey(grid))).resolves.toBeNull();
    await expect(uiPreferences('srv-1', 'Other').get(gridPreferenceKey(grid))).resolves.toBeNull();
    await expect(uiPreferences('srv-1', 'Any').get(gridPreferenceKey({...grid, id: 'trash'}))).resolves.toBeNull();
    // it outlives this run of the app
    forgetUiPreferences();
    await expect(uiPreferences('srv-1', 'Any').get(gridPreferenceKey(grid))).resolves.toBe('5');
  });

  it('never resizes the picker’s grid', () => {
    const preferences = uiPreferences('srv-1', 'Any');
    preferences.set(gridPreferenceKey(grid), '2');
    const picking = {multiple: true, onChange: jest.fn()};
    expect(firstRow(render([grid], {items: items(20)}, context({preferences, picking})))).toBe(fit());
  });

  it('finds the item at the top of the screen again after a new size', () => {
    const entry = (index: number) => ({index, key: `p${index}`} as any);
    const before: Row[] = [
      {kind: 'group', label: 'May', id: 'g0'},
      {kind: 'tiles', entries: [entry(0), entry(1), entry(2)], id: 't0'},
      {kind: 'tiles', entries: [entry(3), entry(4), entry(5)], id: 't3'},
    ];
    const layout: Array<[number, number]> = [[0, 40], [40, 120], [160, 120]];
    expect(rowAt(layout, 0)).toBe(0);
    expect(rowAt(layout, 170)).toBe(2);
    expect(rowAt(layout, 9999)).toBe(2);
    expect(firstEntryFrom(before, 0)).toBe(0); // a heading looks at the tiles below it
    expect(firstEntryFrom(before, 2)).toBe(3);
    const after: Row[] = [
      {kind: 'group', label: 'May', id: 'g0'},
      {kind: 'tiles', entries: [entry(0), entry(1)], id: 't0'},
      {kind: 'tiles', entries: [entry(2), entry(3)], id: 't2'},
      {kind: 'tiles', entries: [entry(4), entry(5)], id: 't4'},
    ];
    expect(rowOfEntry(after, 3)).toBe(2);
    expect(rowOfEntry(after, 9)).toBe(-1);
  });
});

describe('the media viewer’s zoom', () => {
  it('limits panning to the zoomed image’s own edges', () => {
    expect(panLimit(400, 1)).toBe(0);
    expect(panLimit(400, 2)).toBe(200);
    expect(panLimit(400, 0.5)).toBe(0);
  });

  it('pauses swiping between items while the image shown is zoomed', () => {
    const tree = render([grid], {items: items(3)}, context());
    act(() => {
      tiles(tree)[0].props.onPress();
    });
    const pager = () => tree.root.findAllByType(FlatList).find((list: any) => list.props.horizontal)!;
    expect(pager().props.scrollEnabled).toBe(true);
    const shown = tree.root.findAllByType(ZoomableImage).find((image: any) => image.props.active)!;
    expect(shown.props.source.uri).toBe('https://server.test/api/satellites/Any/full/p0');
    act(() => shown.props.onZoomChange(true));
    expect(pager().props.scrollEnabled).toBe(false);
    act(() => shown.props.onZoomChange(false));
    expect(pager().props.scrollEnabled).toBe(true);
  });

  it('is back to its own size, and lets the pager swipe, once its item is no longer shown', () => {
    const onZoomChange = jest.fn();
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<ZoomableImage source={{uri: 'a'}} active onZoomChange={onZoomChange} />);
    });
    expect(onZoomChange).not.toHaveBeenCalled();
    act(() => tree.update(<ZoomableImage source={{uri: 'a'}} active={false} onZoomChange={onZoomChange} />));
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
  });
});
