import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {
  fileExtension, isSelectedRow, locateProvider, openedPage, openersFor, opensOtherSatellites, type Providers, type UiBlock,
} from '../src/satellites/ui/contract';

// change 16: the Satellites that open a file, from the catalog's files.open providers
const opener = (satellite: string, extra: Record<string, any>) => ({
  satellite, version: 1, enabled: true, operations: {open: 'open'}, ...extra,
});
const providers: Providers = {
  'files.open': [
    opener('Pictures', {types: ['image', 'video'], label: 'Pictures'}),
    opener('Player', {types: ['audio']}),
    opener('Raw', {types: ['image'], extensions: ['.cr2']}),
    opener('Off', {types: ['image'], enabled: false}),
    opener('Future', {types: ['image'], version: 2}),
    opener('Broken', {types: ['image'], operations: {}}),
  ],
};

describe('openers (change 16)', () => {
  it('keeps the enabled providers whose extensions hold the file\'s', () => {
    const names = (path: string) => openersFor(providers, path).map(entry => entry.satellite);
    expect(names('/data/Holiday/Beach.JPG')).toEqual(['Pictures']);
    expect(names('C:\\Music\\song.flac')).toEqual(['Player']);
    expect(names('/data/raw/IMG_1.cr2')).toEqual(['Raw']);
    expect(names('/data/notes.txt')).toEqual([]);
    expect(names('/data/.jpg')).toEqual([]);
    expect(openersFor({}, '/a.jpg')).toEqual([]);
    expect(fileExtension('/a/b.tar.GZ')).toBe('.gz');
  });

  it('opens only a page of the provider, with string params', () => {
    expect(openedPage({page: 'folder', params: {path: '/data', select: 'x.jpg'}})).toEqual({
      page: 'folder', params: {path: '/data', select: 'x.jpg'},
    });
    expect(openedPage({page: 'viewer'})).toEqual({page: 'viewer', params: {}});
    for (const answer of [null, {}, {page: '../x'}, {page: 'Folder'}, {page: 'folder', params: {path: 3}}, {page: 'folder', params: ['x']}]) {
      expect(openedPage(answer)).toBeNull();
    }
    const browse = (operations: Record<string, string>): Providers => ({
      'files.browse': [{satellite: 'Files', version: 1, enabled: true, operations}],
    });
    expect(locateProvider(browse({list: 'entries', locate: 'locate'}))?.satellite).toBe('Files');
    expect(locateProvider(browse({list: 'entries'}))).toBeNull();
  });

  it('makes the screen fetch the Satellites for an opener or a locate, not only a section', () => {
    // found on the emulator in O6: without the list, the pushed Satellite was never found
    expect(opensOtherSatellites({pages: {file: {blocks: [{type: 'openers', path: '$.path'}]}}})).toBe(true);
    expect(opensOtherSatellites({pages: {file: {blocks: [{type: 'button', label: 'Show', action: {locate: '$.path'}}]}}})).toBe(true);
    expect(opensOtherSatellites({pages: {home: {blocks: [{type: 'button', action: {section: 'Vault'}}]}}})).toBe(true);
    expect(opensOtherSatellites({pages: {home: {blocks: [{type: 'text', value: 'openers'}]}}})).toBe(false);
    expect(opensOtherSatellites(null)).toBe(false);
    // the documents that use change 16 today
    for (const satellite of ['file_explorer', 'photo', 'music']) {
      expect(opensOtherSatellites(require(`../../satellites/native/${satellite}/ui.json`))).toBe(true);
    }
  });

  const context = (openWith?: BlockContext['openWith']): BlockContext => ({
    developer: false,
    providers,
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    openWith,
    forms: {},
    setEditing: () => {},
  });
  const blocks: UiBlock[] = [{type: 'openers', path: '$.path'}];
  const draw = (ctx: BlockContext, path: string) => {
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<UiBlocks blocks={blocks} scope={{data: {path}, page: {path}, params: {}}} context={ctx} />);
    });
    return tree;
  };
  const labels = (tree: ReturnType<typeof renderer.create>) =>
    tree.root.findAll((node: any) => node.props.accessibilityRole === 'button' && typeof node.type === 'string')
      .map((node: any) => node.props.accessibilityLabel);

  it('draws one pill per provider, by its label, and opens with it', async () => {
    const openWith = jest.fn(async () => true);
    const tree = draw(context(openWith), '/data/Beach.jpg');
    expect(tree.root.findAll((node: any) => node.props.testID === 'openers' && typeof node.type === 'string')).toHaveLength(1);
    expect(labels(tree)).toEqual(['Pictures']);
    const pill = tree.root.find((node: any) => node.props.accessibilityLabel === 'Pictures' && typeof node.props.onPress === 'function');
    await act(async () => {
      await pill.props.onPress();
    });
    expect(openWith).toHaveBeenCalledWith(expect.objectContaining({satellite: 'Pictures'}), '/data/Beach.jpg');
    // a provider without a label is named after its Satellite
    expect(labels(draw(context(openWith), '/music/a.mp3'))).toEqual(['Player']);
  });

  it('draws nothing when no provider opens the file, or nothing can be opened here', () => {
    expect(draw(context(jest.fn()), '/data/notes.txt').toJSON()).toBeNull();
    expect(draw(context(undefined), '/data/Beach.jpg').toJSON()).toBeNull();
  });
});

describe('a list\'s selected row (change 17)', () => {
  it('marks the row the page was opened on, and only that one', () => {
    const list: UiBlock = {
      type: 'list', items: '$.files', item: {title: '$.name', selected: '$.selected'},
      action: {navigate: 'file', params: {path: '$.path'}},
    };
    const files = [{name: 'a.jpg', selected: false}, {name: 'b.jpg', selected: true}, {name: 'c.jpg'}];
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(
        <UiBlocks blocks={[list]} scope={{data: {files}, page: {files}, params: {}}}
          context={{developer: false, providers: {}, runAction: jest.fn(async () => true), readCapability: jest.fn(), forms: {}, setEditing: () => {}}} />,
      );
    });
    const selected = tree.root
      .findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityState?.selected)
      .map((node: any) => node.props.accessibilityLabel);
    expect(selected).toEqual(['b.jpg']);
    expect(isSelectedRow(list, {data: files[1], page: {}, params: {}})).toBe(true);
    expect(isSelectedRow(list, {data: files[2], page: {}, params: {}})).toBe(false);
    expect(isSelectedRow({type: 'list', items: [], item: {title: '$.name'}}, {data: files[1], page: {}, params: {}})).toBe(false);
  });
});
