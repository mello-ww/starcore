import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {CLIENT_CAPABILITIES, servesBlock, type UiBlock} from '../src/satellites/ui/contract';

// a block's requires (UI contract 1.2, change 14): a block is left out unless this app offers
// every client capability it names, as Developer Mode leaves out a developer block
function context(): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: jest.fn(),
    mediaSource: route => ({uri: `https://server.test/${route}`}),
    pageState: {},
    setPageState: jest.fn(),
  };
}

function texts(blocks: UiBlock[]): string[] {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={blocks} scope={{data: {}, page: {}, params: {}, state: {}}} context={context()} />);
  });
  return tree.root.findAllByType(Text).map((node: any) => [].concat(node.props.children).join(''));
}

describe("a block's requires", () => {
  it('leaves out what the audio host does not apply here, and keeps the rest', () => {
    const shown = texts([
      {type: 'text', text: 'Gapless', requires: {client: ['media.audio-gapless']}},
      {type: 'text', text: 'Crossfade', requires: {client: ['media.audio-crossfade']}},
      {type: 'text', text: 'Looks', requires: {client: ['media.audio-theme', 'media.audio-density', 'media.audio-visualizer']}},
      {type: 'text', text: 'Play', requires: {client: ['media.audio']}},
      {type: 'text', text: 'Normalize'},
    ]);
    expect(shown).toEqual(['Play', 'Normalize']);
  });

  it('needs every capability it names', () => {
    expect(servesBlock({requires: {client: ['media.audio', 'secure.screen']}})).toBe(true);
    expect(servesBlock({requires: {client: ['media.audio', 'media.audio-gapless']}})).toBe(false);
    expect(servesBlock({requires: {client: []}})).toBe(true);
    expect(servesBlock({})).toBe(true);
    expect(CLIENT_CAPABILITIES.has('media.audio-crossfade')).toBe(false);
  });
});
