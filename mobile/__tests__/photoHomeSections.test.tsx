import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {PhotoHomeScreen} from '../src/photo/PhotoHomeScreen';

// the tabs themselves are tested elsewhere; here only which one the screen shows
jest.mock('../src/photo/PhotoLibraryTab', () => ({PhotoLibraryTab: () => null}));
jest.mock('../src/photo/PhotoAlbumsTab', () => ({PhotoAlbumsTab: () => null}));
jest.mock('../src/photo/PhotoMapTab', () => ({PhotoMapTab: () => null}));
jest.mock('../src/photo/PhotoSearchTab', () => ({PhotoSearchTab: () => null}));
jest.mock('../src/components/SettingsButton', () => ({SettingsButton: () => null}));

function navigationMock() {
  return {navigate: jest.fn(), replace: jest.fn(), push: jest.fn(), goBack: jest.fn()} as any;
}

async function mount(params?: {section?: string}) {
  const navigation = navigationMock();
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<PhotoHomeScreen navigation={navigation} route={{key: 'k', name: 'PhotoHome', params} as any} />);
  });
  return {tree, navigation};
}

const texts = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));

const selected = (tree: ReturnType<typeof renderer.create>) =>
  tree.root
    .findAll(
      (node: any) =>
        typeof node.type === 'string' && node.props.accessibilityRole === 'tab' && node.props.accessibilityState?.selected,
    )
    .map((node: any) => node.props.accessibilityLabel ?? '');

/** Photo's own screens, opened at a section by the own action. */
describe('PhotoHomeScreen sections', () => {
  it('opens at the segment a section names', async () => {
    const {tree, navigation} = await mount({section: 'albums'});
    expect(selected(tree)).toEqual(['Albums']);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('opens at the library without a section, or with one it does not know (phone sync is gone)', async () => {
    for (const params of [undefined, {section: 'sync'}, {section: 'elsewhere'}, {section: 'LockedFolder'}]) {
      const {tree, navigation} = await mount(params);
      expect(texts(tree)).toEqual(expect.arrayContaining(['Photos', 'Library', 'Albums']));
      expect(selected(tree)).toEqual(['Library']);
      expect(navigation.replace).not.toHaveBeenCalled();
      act(() => tree.unmount());
    }
  });
});
