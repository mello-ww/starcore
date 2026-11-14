import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert, Image, NativeModules, Pressable, Text, TextInput} from 'react-native';
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

const FILE = {
  name: 'notes.txt',
  path: '/home/demo/notes.txt',
  folder: '/home/demo',
  size: 1536,
  modified: 1794477600,
  kind: 'TXT file',
  preview: false,
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
      if (route.startsWith('view/file?path=')) return FILE;
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

  it('draws a folder as one virtualized list, and a page without a paged list as before', async () => {
    const {tree} = await mount({params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}});
    expect(tree.root.findAllByProps({testID: 'ui-list-page'})).not.toHaveLength(0);
    const locations = await mount({params: {name: 'FileExplorer', revision: 'rev1'}});
    expect(locations.tree.root.findAllByProps({testID: 'ui-list-page'})).toHaveLength(0);
  });

  it('loads the next page of each list once its end is near, until there is none', async () => {
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route.includes('part=folders')) return {folders: [{name: 'Zeta', path: '/home/demo/Zeta', icon: 'folder'}], folders_next: null};
      if (route.includes('part=files')) return {files: [{name: 'z.txt', path: '/home/demo/z.txt', icon: 'file', size: 1}], files_next: null};
      return {...FOLDER, folders_next: 'vault', files_next: 'notes.txt'};
    });
    const {tree} = await mount({params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}});
    const routes = __mocks.read.mock.calls.map(([, route]) => route);
    expect(routes).toEqual(expect.arrayContaining([
      'view/folder?path=%2Fhome%2Fdemo&part=folders&cursor=vault',
      'view/folder?path=%2Fhome%2Fdemo&part=files&cursor=notes.txt',
    ]));
    const shown = texts(tree);
    expect(shown.indexOf('Zeta')).toBeGreaterThan(shown.indexOf('vault'));
    expect(shown.indexOf('notes.txt')).toBeGreaterThan(shown.indexOf('Zeta'));
    expect(shown.indexOf('z.txt')).toBeGreaterThan(shown.indexOf('notes.txt'));
    expect(tree.root.findAllByProps({testID: 'list-more'})).toHaveLength(0);
  });

  it('leaves a list far below the screen alone', async () => {
    const many = Array.from({length: 60}, (_, index) => ({name: `folder-${index}`, path: `/home/demo/folder-${index}`, icon: 'folder'}));
    __mocks.read.mockResolvedValue({...FOLDER, folders: many, folders_next: 'folder-59', files_next: 'notes.txt'});
    const {tree} = await mount({params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}});
    expect(__mocks.read.mock.calls.map(([, route]) => route).filter((route: string) => route.includes('part='))).toEqual([]);
    expect(texts(tree)).toContain('folder-0');
    expect(texts(tree)).not.toContain('folder-59'); // not mounted
  });

  it('says why a page failed, and tries again on request', async () => {
    let fail = true;
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route.includes('part=files')) {
        if (fail) {
          fail = false;
          throw new Error('Server unreachable');
        }
        return {files: [{name: 'z.txt', path: '/home/demo/z.txt', icon: 'file', size: 1}], files_next: null};
      }
      return {...FOLDER, files_next: 'notes.txt'};
    });
    const {tree} = await mount({params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}});
    expect(texts(tree)).toContain('Server unreachable');
    await press(tree, 'Try again');
    expect(texts(tree)).toContain('z.txt');
    expect(texts(tree)).not.toContain('Server unreachable');
  });

  it("opens a file's page from its row", async () => {
    const {tree, navigation} = await mount({
      params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'},
    });
    await press(tree, 'notes.txt');
    expect(navigation.push).toHaveBeenLastCalledWith('SatelliteUi', {
      name: 'FileExplorer', page: 'file', params: {path: '/home/demo/notes.txt'}, revision: 'rev1',
    });
  });

  describe("a file's page", () => {
    afterEach(() => {
      delete (NativeModules as any).StarCoreFiles;
    });

    const route = {params: {name: 'FileExplorer', page: 'file', params: {path: '/home/demo/notes.txt'}, revision: 'rev1'}};

    it('shows the details, and no picture for a file that is not one', async () => {
      const {tree, navigation} = await mount(route);
      expect(__mocks.read).toHaveBeenCalledWith('FileExplorer', 'view/file?path=%2Fhome%2Fdemo%2Fnotes.txt');
      expect(navigation.setOptions).toHaveBeenLastCalledWith({title: 'notes.txt'});
      expect(texts(tree)).toEqual(expect.arrayContaining(['Size', '1.5 KB', 'Type', 'TXT file', 'Folder', '/home/demo']));
      expect(tree.root.findAllByType(Image)).toHaveLength(0);
      // under Jest there is no native module: the file controls are hidden
      expect(texts(tree)).not.toEqual(expect.arrayContaining(['Open']));
    });

    it('previews a picture from the content route', async () => {
      __mocks.read.mockResolvedValue({...FILE, name: 'photo.jpg', path: '/home/demo/photo.jpg', kind: 'JPEG image', preview: true});
      const {tree} = await mount({params: {...route.params, params: {path: '/home/demo/photo.jpg'}}});
      const sources = tree.root.findAllByType(Image).map((node: any) => node.props.source?.uri);
      expect(sources).toEqual(expect.arrayContaining([expect.stringContaining('/api/satellites/FileExplorer/content?path=%2Fhome%2Fdemo%2Fphoto.jpg')]));
    });

    it("opens, downloads and shares the file through the app's own module", async () => {
      const files = {
        canSave: true, canShare: true, canOpen: true,
        open: jest.fn(async () => true), save: jest.fn(async () => ({name: 'notes.txt'})), share: jest.fn(async () => true),
      };
      (NativeModules as any).StarCoreFiles = files;
      const {tree} = await mount(route);
      await press(tree, 'Open');
      expect(files.open).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/satellites\/FileExplorer\/content\?path=%2Fhome%2Fdemo%2Fnotes\.txt$/), expect.anything(), 'notes.txt');
      await press(tree, 'Download');
      expect(files.save).toHaveBeenCalledWith(
        expect.stringMatching(/content\?path=%2Fhome%2Fdemo%2Fnotes\.txt&download=1$/), expect.anything(), 'notes.txt');
      await press(tree, 'Share');
      expect(files.share).toHaveBeenCalledWith(expect.stringMatching(/content\?path=%2Fhome%2Fdemo%2Fnotes\.txt$/), expect.anything(), 'notes.txt');
    });

    it('offers Open where saving is not possible (an Android older than 10)', async () => {
      (NativeModules as any).StarCoreFiles = {canSave: false, canShare: true, canOpen: true, open: jest.fn(), share: jest.fn()};
      const {tree} = await mount(route);
      const shown = texts(tree);
      expect(shown).toEqual(expect.arrayContaining(['Open', 'Share']));
      expect(shown).not.toContain('Download');
    });
  });

  describe('management (F4)', () => {
    const folderRoute = {params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}};
    const fileRoute = {params: {name: 'FileExplorer', page: 'file', params: {path: '/home/demo/notes.txt'}, revision: 'rev1'}};

    it('creates a folder in the one shown, then reloads it', async () => {
      __mocks.act.mockResolvedValue({name: 'New', path: '/home/demo/New'});
      const {tree} = await mount(folderRoute);
      await act(async () => {
        tree.root.findAllByType(TextInput)[0].props.onChangeText('New');
      });
      await press(tree, 'Create folder');
      expect(__mocks.act).toHaveBeenCalledWith('FileExplorer', 'mkdir', 'POST', {path: '/home/demo', name: 'New'});
    });

    it('renames a file, then goes back to its folder', async () => {
      __mocks.act.mockResolvedValue({name: 'renamed.txt', path: '/home/demo/renamed.txt', folder: '/home/demo'});
      const {tree, navigation} = await mount(fileRoute);
      const input = tree.root.findAllByType(TextInput)[0];
      expect(input.props.value).toBe('notes.txt');
      await act(async () => {
        input.props.onChangeText('renamed.txt');
      });
      await press(tree, 'Rename');
      expect(__mocks.act).toHaveBeenCalledWith('FileExplorer', 'rename', 'POST', {path: '/home/demo/notes.txt', name: 'renamed.txt'});
      expect(navigation.goBack).toHaveBeenCalled();
    });

    it('asks before deleting, deletes only when confirmed, then goes back', async () => {
      __mocks.act.mockResolvedValue({deleted: '/home/demo/notes.txt'});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find(button => button.style === 'cancel')?.onPress?.();
      });
      const {tree, navigation} = await mount(fileRoute);
      await press(tree, 'Delete this file');
      expect(alert).toHaveBeenCalledWith(expect.stringContaining('cannot be undone'), undefined, expect.any(Array), expect.any(Object));
      expect(__mocks.act).not.toHaveBeenCalled();
      alert.mockImplementation((_title, _message, buttons) => {
        buttons?.find(button => button.style !== 'cancel')?.onPress?.();
      });
      await press(tree, 'Delete this file');
      expect(__mocks.act).toHaveBeenCalledWith('FileExplorer', 'delete', 'POST', {path: '/home/demo/notes.txt'});
      expect(navigation.goBack).toHaveBeenCalled();
      alert.mockRestore();
    });

    it('offers no rename or delete for a drive root', async () => {
      __mocks.read.mockResolvedValue({...FOLDER, path: '/', name: '/', parent: null, at_drive_root: true});
      const {tree} = await mount({params: {...folderRoute.params, params: {path: '/'}}});
      const shown = texts(tree);
      expect(shown).toContain('Create folder');
      expect(shown).not.toContain('Rename');
      expect(shown).not.toContain('Delete this folder');
    });
  });

  describe('upload (F5)', () => {
    const folderRoute = {params: {name: 'FileExplorer', page: 'folder', params: {path: '/home/demo'}, revision: 'rev1'}};

    afterEach(() => {
      delete (NativeModules as any).StarCoreFiles;
    });

    it('hides Upload files where the phone cannot pick files', async () => {
      const {tree} = await mount(folderRoute);
      expect(texts(tree)).not.toContain('Upload files');
    });

    it('sends each picked file to the upload route, asks before replacing one, then reloads', async () => {
      const answers = [
        {status: 200, body: '{"name": "a.txt"}'},
        {status: 409, body: '{"error": "\'notes.txt\' already exists"}'},
        {status: 200, body: '{"name": "notes.txt"}'},
      ];
      const files = {
        canUpload: true,
        pick: jest.fn(async () => [
          {uri: 'content://docs/1', name: 'a.txt', size: 3},
          {uri: 'content://docs/2', name: 'notes.txt', size: 5},
        ]),
        upload: jest.fn(async () => answers.shift()),
      };
      (NativeModules as any).StarCoreFiles = files;
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find(button => button.style !== 'cancel')?.onPress?.();
      });
      const {tree} = await mount(folderRoute);
      const reads = __mocks.read.mock.calls.length;
      await press(tree, 'Upload files');
      expect(files.pick).toHaveBeenCalledWith(true);
      expect(files.upload.mock.calls.map(([uri, url]: any[]) => [uri, url])).toEqual([
        ['content://docs/1', '/api/satellites/FileExplorer/upload?path=%2Fhome%2Fdemo&name=a.txt'],
        ['content://docs/2', '/api/satellites/FileExplorer/upload?path=%2Fhome%2Fdemo&name=notes.txt'],
        ['content://docs/2', '/api/satellites/FileExplorer/upload?path=%2Fhome%2Fdemo&name=notes.txt&overwrite=1'],
      ]);
      // the file is named as the title, the document's question beneath it
      expect(alert).toHaveBeenCalledWith('notes.txt', expect.stringContaining('Replace it?'), expect.any(Array), expect.any(Object));
      expect(texts(tree)).toContain('Uploaded 2 files.');
      expect(__mocks.read.mock.calls.length).toBeGreaterThan(reads);
      expect(__mocks.act).not.toHaveBeenCalled();
      alert.mockRestore();
    });

    it('reports a file kept or failed, never the whole selection as uploaded', async () => {
      const answers = [{status: 409, body: '{}'}, {status: 413, body: '{"error": "too large"}'}];
      (NativeModules as any).StarCoreFiles = {
        canUpload: true,
        pick: jest.fn(async () => [{uri: 'content://docs/1', name: 'a.txt', size: 1}, {uri: 'content://docs/2', name: 'big.iso', size: 9}]),
        upload: jest.fn(async () => answers.shift()),
      };
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find(button => button.style === 'cancel')?.onPress?.();
      });
      const {tree} = await mount(folderRoute);
      await press(tree, 'Upload files');
      expect(texts(tree)).toContain('Uploaded 0 of 2 files. Kept the existing a.txt. Could not upload big.iso (too large).');
      alert.mockRestore();
    });

    it('runs nothing when the picker is closed', async () => {
      const files = {canUpload: true, pick: jest.fn(async () => []), upload: jest.fn()};
      (NativeModules as any).StarCoreFiles = files;
      const {tree} = await mount(folderRoute);
      await press(tree, 'Upload files');
      expect(files.upload).not.toHaveBeenCalled();
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
