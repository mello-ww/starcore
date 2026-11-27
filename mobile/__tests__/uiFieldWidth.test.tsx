import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import type {UiBlock} from '../src/satellites/ui/contract';

// a long field value sits under its label across the whole width instead of wrapping beside it
const context: BlockContext = {
  developer: false,
  providers: {},
  runAction: jest.fn(async () => true),
  readCapability: jest.fn(),
  forms: {},
  setEditing: () => {},
  mediaSource: route => ({uri: `https://server.test/${route}`}),
  setOverlay: jest.fn(),
};

it('gives only a long value a line of its own', () => {
  const blocks: UiBlock[] = [
    {type: 'field', label: 'Type', value: '$.kind'},
    {type: 'field', label: 'Folder', value: '$.folder'},
  ];
  const data = {kind: 'MP4 video', folder: '/data/shared/videos/holidays/summer'};
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data, page: data, params: {}}} context={context} />);
  });
  const wide = tree.root.findAll((node: any) => node.props.testID === 'field-wide' && typeof node.type === 'string');
  expect(wide).toHaveLength(1);
  const texts = wide[0].findAll((node: any) => typeof node.props.children === 'string').map((node: any) => node.props.children);
  expect(texts).toContain('Folder');
});
