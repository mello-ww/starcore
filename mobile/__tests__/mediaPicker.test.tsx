import React from 'react';
import {Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {isSafeRoute} from '../src/satellites/ui/contract';
import {listRoute, MediaPicker, references, type PickRequest} from '../src/satellites/ui/MediaPicker';

// the media picker (media.picker, UI contract 1.2's pick action): it lists what the
// media.gallery provider offers in the shared grid and resolves with references
const provider = {satellite: 'Gallery', version: 1, enabled: true, operations: {list: 'media', thumbnail: 'thumbs'}};
const listed = {
  items: [
    {id: 'a', kind: 'image', title: 'a.jpg', group: 'November 2026'},
    {id: 'b', kind: 'video', title: 'b.mp4', duration: 5, group: 'November 2026'},
    {id: 'c', kind: 'image', title: 'c.jpg', group: 'October 2026'},
  ],
};

async function open(overrides: Partial<PickRequest> = {}) {
  const resolve = jest.fn();
  const read = jest.fn(async () => listed);
  const mediaSource = jest.fn((satellite: string, route: string) => ({uri: `https://server.test/api/satellites/${satellite}/${route}`}));
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(
      <MediaPicker
        request={{provider, capability: 'media.gallery', multiple: true, title: 'Add pictures', resolve, ...overrides}}
        read={read}
        mediaSource={mediaSource}
      />,
    );
  });
  return {tree, resolve, read, mediaSource};
}

const tile = (tree: ReturnType<typeof renderer.create>, key: string) =>
  tree.root.find((node: any) => node.type === Pressable && node.props.testID === `media-tile-${key}`);
const confirm = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.find((node: any) => node.type === Pressable && node.props.testID === 'media-picker-confirm');

describe('the media picker', () => {
  it('lists the accepted kinds from the provider, with its thumbnails', async () => {
    const {tree, read, mediaSource} = await open({kinds: ['image']});
    expect(read).toHaveBeenCalledWith('Gallery', 'media?kinds=image');
    expect(mediaSource).toHaveBeenCalledWith('Gallery', 'thumbs/a');
    expect(tree.root.findAll((node: any) => node.type === Pressable && String(node.props.testID).startsWith('media-tile-'))).toHaveLength(2);
  });

  it('returns references to what was chosen, never paths', async () => {
    const {tree, resolve} = await open();
    act(() => tile(tree, 'a').props.onPress());
    act(() => tile(tree, 'b').props.onPress());
    expect(tree.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('2 selected');
    act(() => confirm(tree).props.onPress());
    expect(resolve).toHaveBeenCalledWith([
      {provider: 'Gallery', capability: 'media.gallery', id: 'a', kind: 'image'},
      {provider: 'Gallery', capability: 'media.gallery', id: 'b', kind: 'video'},
    ]);
  });

  it('keeps one choice at a time when the pick is single', async () => {
    const {tree, resolve} = await open({multiple: false});
    act(() => tile(tree, 'a').props.onPress());
    act(() => tile(tree, 'c').props.onPress());
    act(() => confirm(tree).props.onPress());
    expect(resolve).toHaveBeenCalledWith([{provider: 'Gallery', capability: 'media.gallery', id: 'c', kind: 'image'}]);
  });

  it('resolves null on cancel, and confirms nothing while nothing is chosen', async () => {
    const {tree, resolve} = await open();
    expect(confirm(tree).props.disabled).toBe(true);
    const cancel = tree.root.find((node: any) => node.type === Pressable && node.props.accessibilityLabel === 'Cancel');
    act(() => cancel.props.onPress());
    expect(resolve).toHaveBeenCalledWith(null);
  });
});

describe('media picker helpers', () => {
  it('builds references and the list route', () => {
    expect(references(provider, 'media.gallery', [{id: 7, kind: 'video', path: '/srv/x.mp4'}])).toEqual([
      {provider: 'Gallery', capability: 'media.gallery', id: '7', kind: 'video'},
    ]);
    expect(listRoute(provider, ['video', 'audio'])).toBe('media?kinds=video');
    expect(listRoute(provider)).toBe('media?kinds=image%2Cvideo');
    expect(isSafeRoute(listRoute(provider) as string)).toBe(true);
    expect(listRoute({...provider, operations: {list: '../x'}})).toBeNull();
  });
});
