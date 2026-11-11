import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text} from 'react-native';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn(() => ({client: {}}))}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});

const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {
  __mocks: {document: jest.Mock; providers: jest.Mock; read: jest.Mock; act: jest.Mock};
};

// File Explorer's real document (satellites/native/file_explorer/ui.json, F1 of
// docs/file-explorer-migration.md) and answers shaped like its view routes (views.py):
// the shared screen has no idea what File Explorer is
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};
const DOCUMENT = JSON.parse(readFileSync(join(__dirname, '..', '..', 'satellites', 'native', 'file_explorer', 'ui.json'), 'utf-8'));

const LOCATIONS = {
  drives: [{path: '/', title: '/', summary: '120 GB free of 500 GB', used_percent: 76}],
  machine: {used: 380 * 1024 ** 3, total: 500 * 1024 ** 3, free: 120 * 1024 ** 3, volumes: 1},
  machine_summary: '120 GB free across 1 drive',
};

const FOLDER = {
  path: '/home/demo',
  name: 'demo',
  parent: '/home',
  at_drive_root: false,
  folders: [
    {name: 'Documents', path: '/home/demo/Documents', modified: 1794477600, subtitle: 1794477600, icon: 'folder'},
    {name: 'vault', path: '/home/demo/vault', modified: 1794477600, subtitle: 'Locked', icon: 'lock'},
  ],
  files: [{name: 'notes.txt', path: '/home/demo/notes.txt', modified: 1794477600, icon: 'file', size: 1536}],
  has_folders: true,
  has_files: true,
  empty: false,
  summary: '2 folders, 1 file',
  storage: '120 GB free of 500 GB',
};

const mounted: ReturnType<typeof renderer.create>[] = [];

async function mount(route: any) {
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={route} />);
  });
  mounted.push(tree);
  return {tree, navigation};
}

function texts(tree: ReturnType<typeof renderer.create>): string[] {
  return tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join('')).filter(Boolean);
}

async function press(tree: ReturnType<typeof renderer.create>, label: string) {
  const target = tree.root.findAll(
    (node: any) => node.type === Pressable && [node.props.accessibilityLabel, ...texts({root: node} as any)].includes(label),
  )[0];
  if (!target) {
    throw new Error(`nothing to press labelled ${label}`);
  }
  await act(async () => {
    await target.props.onPress();
  });
}

describe('File Explorer, drawn from its ui.json by the shared screen', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(tree => tree.unmount());
    });
  });

  beforeEach(() => {
    for (const mock of Object.values(__mocks)) {
      mock.mockReset();
    }
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'rev1', offline: false});
    __mocks.providers.mockResolvedValue({});
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route === 'view/locations') return LOCATIONS;
      if (route.startsWith('view/folder?path=')) return FOLDER;
      throw new Error(`unexpected route ${route}`);
    });
  });

  it('lists the locations with their storage and opens one', async () => {
    const {tree, navigation} = await mount({params: {name: 'FileExplorer', revision: 'rev1'}});
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['/', '120 GB free of 500 GB', '120 GB free across 1 drive']));
    await press(tree, '/');
    expect(navigation.push).toHaveBeenCalledWith('SatelliteUi', {
      name: 'FileExplorer', page: 'folder', params: {path: '/'}, revision: 'rev1',
    });
  });

  it('shows a folder, its folders then its files, and goes into one or up', async () => {
    const {tree, navigation} = await mount({
      params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'},
    });
    expect(__mocks.read).toHaveBeenCalledWith('FileExplorer', 'view/folder?path=%2Fhome%2Fdemo');
    expect(navigation.setOptions).toHaveBeenLastCalledWith({title: 'demo'});
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['/home/demo', '2 folders, 1 file', 'Documents', 'vault', 'Locked', 'notes.txt', '1.5 KB']));
    expect(shown).not.toContain('All locations');
    expect(shown).not.toContain('—');

    await press(tree, 'Documents');
    expect(navigation.push).toHaveBeenLastCalledWith('SatelliteUi', {
      name: 'FileExplorer', page: 'folder', params: {path: '/home/demo/Documents'}, revision: 'rev1',
    });
    await press(tree, 'Up');
    expect(navigation.push).toHaveBeenLastCalledWith('SatelliteUi', {
      name: 'FileExplorer', page: 'folder', params: {path: '/home'}, revision: 'rev1',
    });
  });

  it('goes back to the locations from a drive root', async () => {
    __mocks.read.mockResolvedValue({...FOLDER, path: '/', name: '/', parent: null, at_drive_root: true});
    const {tree} = await mount({params: {name: 'FileExplorer', page: 'folder', params: {path: '/'}, revision: 'rev1'}});
    const shown = texts(tree);
    expect(shown).toContain('All locations');
    expect(shown).not.toContain('Up');
  });
});
