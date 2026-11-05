import React from 'react';
import {Image, Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import type {UiBlock} from '../src/satellites/ui/contract';

// the image and media-list blocks (UI contract 1.2), with a context like the screen's: images
// come from the Satellite's own routes, with the session as a header
function context(runAction = jest.fn(async () => true)): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction,
    readCapability: jest.fn(),
    forms: {},
    setEditing: () => {},
    mediaSource: route => ({uri: `https://server.test/api/satellites/Any/${route}`, headers: {Authorization: 'Bearer t'}}),
  };
}

function render(blocks: UiBlock[], data: any, ctx = context()) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data, page: data, params: {}}} context={ctx} />);
  });
  return tree;
}

describe('the image block', () => {
  it('loads from the Satellite’s own route, with the session, and shows its caption', () => {
    const tree = render([{type: 'image', src: 'covers/{$.id}?size=600', caption: '$.title', alt: '$.title', size: 'large'}],
      {id: 'a 1', title: 'Cover'});
    const image = tree.root.findByType(Image);
    expect(image.props.source).toEqual({uri: 'https://server.test/api/satellites/Any/covers/a%201?size=600', headers: {Authorization: 'Bearer t'}});
    expect(image.props.resizeMode).toBe('cover');
    expect(tree.root.findAllByType(Text).map((node: any) => node.props.children)).toContain('Cover');
  });

  it('shows the placeholder, and loads nothing, for a route outside the Satellite', () => {
    const tree = render([{type: 'image', src: '../other/{$.id}'}], {id: 'x'});
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
  });

  it('falls back to the placeholder when the image fails to load', () => {
    const tree = render([{type: 'image', src: 'cover', fit: 'contain'}], {});
    const image = tree.root.findByType(Image);
    expect(image.props.resizeMode).toBe('contain');
    act(() => image.props.onError());
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
  });
});

describe('the media-list block', () => {
  const block: UiBlock = {
    type: 'media-list', items: '$.entries', size: 'medium', shape: 'round', empty: 'Nothing yet.',
    item: {title: '$.title', subtitle: '$.size', meta: '$.count', image: 'thumbs/{$.id}', format: {subtitle: 'bytes'}},
    action: {navigate: 'detail', params: {id: '$.id'}},
  };

  it('draws a row per item with its thumbnail, text and metadata, and runs the row action', () => {
    const runAction = jest.fn(async () => true);
    const tree = render([block], {entries: [{id: 'one', title: 'First', size: 2048, count: 3}, {id: 'two', title: 'Second'}]},
      context(runAction));
    const images = tree.root.findAllByType(Image);
    expect(images.map((image: any) => image.props.source.uri)).toEqual([
      'https://server.test/api/satellites/Any/thumbs/one',
      'https://server.test/api/satellites/Any/thumbs/two',
    ]);
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children);
    expect(texts).toEqual(expect.arrayContaining(['First', '2 KB', '3', 'Second']));
    const rows = tree.root.findAllByType(Pressable);
    expect(rows).toHaveLength(2);
    act(() => rows[0].props.onPress());
    expect(runAction).toHaveBeenCalledWith(block.action, expect.objectContaining({data: expect.objectContaining({id: 'one'})}));
  });

  it('says what its empty text says when there is nothing', () => {
    const tree = render([block], {entries: []});
    expect(tree.root.findByType(Text).props.children).toBe('Nothing yet.');
  });
});
