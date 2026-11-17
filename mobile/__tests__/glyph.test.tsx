import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Glyph, GlyphIcons} from '../src/components/Glyph';
import {satelliteIcon} from '../src/satellites/icons';
import {tileIcon} from '../src/satellites/ui/MediaGrid';
import {isIconName, knownIcons, type OwnIcons} from '../src/satellites/ui/contract';

// A Satellite's own icons (UI contract 1.2): path data the Engine validated from its icons/
// folder, stroked by the native StarCoreGlyph view (android/.../glyph/GlyphView.kt); a refused
// one, or one where the native view isn't there, draws its shared fallback.

jest.mock('react-native-vector-icons/Feather', () => 'Icon');

type Tree = ReturnType<typeof renderer.create>;

const own: OwnIcons = {
  albums: {fallback: 'folder', stroke: 1.6, paths: ['M2 12L22 12', 'M12 2L12 22']},
  spare: {fallback: 'box'},
};

async function mount(element: React.ReactElement) {
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(element);
  });
  return tree;
}

const drawn = (tree: Tree) =>
  tree.root.findAll((node: any) => typeof node.type === 'string').map((node: any) => [node.type, node.props.name]);

describe('Glyph', () => {
  it('draws a shared name, and an own one through its fallback where the native view is missing', async () => {
    expect(drawn(await mount(<Glyph name="lock" size={18} color="#fff" />))).toEqual([['Icon', 'lock']]);
    expect(drawn(await mount(<Glyph name="albums" icons={own} size={18} color="#fff" />))).toEqual([['Icon', 'folder']]);
    expect(drawn(await mount(<Glyph name="spare" icons={own} size={18} color="#fff" />))).toEqual([['Icon', 'box']]);
  });

  it('takes the document’s icons from GlyphIcons', async () => {
    const tree = await mount(
      <GlyphIcons icons={own}>
        <Glyph name="spare" size={18} color="#fff" />
      </GlyphIcons>,
    );
    expect(drawn(tree)).toEqual([['Icon', 'box']]);
  });

  it('strokes the paths in the native view when it is there', async () => {
    const {UIManager} = require('react-native');
    const config = jest.spyOn(UIManager, 'getViewManagerConfig').mockImplementation(
      (name: unknown) => (name === 'StarCoreGlyph' ? ({} as any) : undefined),
    );
    const tree = await mount(<Glyph name="albums" icons={own} size={20} color="#abcdef" />);
    config.mockRestore();
    const view = tree.root.find((node: any) => node.type === 'StarCoreGlyph');
    expect(view.props.paths).toEqual(own.albums.paths);
    expect(view.props.stroke).toBe(1.6);
    expect(view.props.color).toBe('#abcdef');
    expect(view.props.style).toEqual([{width: 20, height: 20}, undefined]);
    // a refused one is still its fallback
    expect(drawn(await mount(<Glyph name="spare" icons={own} size={20} color="#fff" />))).toEqual([['Icon', 'box']]);
  });
});

describe('own icon names', () => {
  it('names one only where the document has it', () => {
    expect(isIconName('albums', own)).toBe(true);
    expect(isIconName('albums', null)).toBe(false);
    expect(isIconName('toString', own)).toBe(false);
    expect(isIconName('lock', null)).toBe(true);
    expect(tileIcon({item: {icon: '$.icon'}} as any, {data: {icon: 'albums'}} as any, own)).toBe('albums');
    expect(tileIcon({item: {icon: '$.icon'}} as any, {data: {icon: 'albums'}} as any)).toBeNull();
  });

  it('gives a Satellite its own icon, else its shared one, else a circle', () => {
    expect(satelliteIcon({icon: 'albums', icon_name: 'image', icons: own})).toBe('albums');
    expect(satelliteIcon({icon: 'gone', icon_name: 'image', icons: own})).toBe('image');
    expect(satelliteIcon({icon: null, icon_name: 'image'})).toBe('image');
    expect(satelliteIcon({icon: null, icon_name: 'rocket'})).toBe('circle');
  });

  it('checks a document’s icons as Mission Control does', () => {
    expect(knownIcons(own)).toBe(true);
    expect(knownIcons({albums: {fallback: 'folder', paths: ['M1 1L2 2']}})).toBe(false);
    expect(knownIcons({albums: {fallback: 'folder', stroke: 2, paths: ['M1 1l2 2']}})).toBe(false);
    expect(knownIcons({camera: {fallback: 'camera'}})).toBe(false);
    expect(knownIcons([])).toBe(false);
  });
});
