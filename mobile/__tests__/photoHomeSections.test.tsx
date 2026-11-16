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

/** Photo's own screens, opened at a section by its shared interface's own action. */
describe('PhotoHomeScreen sections', () => {
  it('opens Photo configuration in its place for "sync", so Back returns to the shared screen', async () => {
    const {navigation} = await mount({section: 'sync'});
    expect(navigation.replace).toHaveBeenCalledWith('PhotoConfiguration');
  });

  it('opens as before without a section, or with one it does not know', async () => {
    for (const params of [undefined, {section: 'elsewhere'}, {section: 'LockedFolder'}]) {
      const {tree, navigation} = await mount(params);
      expect(texts(tree)).toEqual(expect.arrayContaining(['Photos', 'Library', 'Albums']));
      expect(navigation.replace).not.toHaveBeenCalled();
      act(() => tree.unmount());
    }
  });
});
