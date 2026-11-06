import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {PhotoHomeScreen} from '../src/photo/PhotoHomeScreen';

// the tabs themselves are tested elsewhere; here only which one the screen shows
jest.mock('../src/photo/PhotoLibraryTab', () => ({PhotoLibraryTab: () => null}));
jest.mock('../src/photo/PhotoAlbumsTab', () => ({PhotoAlbumsTab: () => null}));
jest.mock('../src/photo/PhotoMapTab', () => ({PhotoMapTab: () => null}));
jest.mock('../src/photo/PhotoSearchTab', () => ({PhotoSearchTab: () => null}));
jest.mock('../src/photo/LockedFolderTab', () => {
  const {Text: MockText} = require('react-native');
  return {LockedFolderTab: () => <MockText>Locked Folder tab</MockText>};
});
jest.mock('../src/components/SettingsButton', () => ({SettingsButton: () => null}));
const mockStatus = jest.fn();
const mockLocked = {api: {status: mockStatus}};
jest.mock('../src/lockedFolder/useLockedFolder', () => ({useLockedFolder: () => mockLocked}));

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
  beforeEach(() => mockStatus.mockReset());

  it('opens Photo configuration in its place for "settings", so Back returns to the shared screen', async () => {
    mockStatus.mockResolvedValue({configured: true});
    const {navigation} = await mount({section: 'settings'});
    expect(navigation.replace).toHaveBeenCalledWith('PhotoConfiguration');
  });

  it('shows the Locked Folder alone for "locked" - its own tab, with its own PIN', async () => {
    mockStatus.mockResolvedValue({configured: true, unlocked: false});
    const {tree, navigation} = await mount({section: 'locked'});
    expect(texts(tree)).toEqual(expect.arrayContaining(['Locked Folder', 'Locked Folder tab']));
    expect(texts(tree)).not.toContain('Library');
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('says so when the server has no Locked Folder', async () => {
    mockStatus.mockResolvedValue(null);
    const {tree} = await mount({section: 'locked'});
    expect(texts(tree)).toContain('This StarCore server has no Locked Folder.');
    expect(texts(tree)).not.toContain('Locked Folder tab');
  });

  it('opens as before without a section, or with one it does not know', async () => {
    mockStatus.mockResolvedValue(null);
    for (const params of [undefined, {section: 'elsewhere'}]) {
      const {tree, navigation} = await mount(params);
      expect(texts(tree)).toEqual(expect.arrayContaining(['Photos', 'Library', 'Albums']));
      expect(navigation.replace).not.toHaveBeenCalled();
      act(() => tree.unmount());
    }
  });
});
