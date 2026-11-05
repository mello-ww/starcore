import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert, Pressable, Text, TextInput} from 'react-native';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {Slider} from '../src/components/Slider';
import {StarSwitch} from '../src/components/StarSwitch';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn(() => ({client: {}}))}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});

import {useDeveloperMode} from '../src/developer/DeveloperModeContext';
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {
  __mocks: {document: jest.Mock; providers: jest.Mock; read: jest.Mock; act: jest.Mock};
};

// the real example Satellite's document (examples/satellites/native/showcase/ui.json):
// this screen has no idea what "Showcase" is beyond that
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};
const SHOWCASE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'examples', 'satellites', 'native', 'showcase', 'ui.json'), 'utf-8'),
);

const SUMMARY = {
  enabled: true, disabled: false, level: 40, uptime: 125, counter: 3, counter_tone: 'neutral',
  selected: null, last_action: 'Started', diagnostics: '0 items in memory',
};
const ITEMS = {items: [{id: '7', title: 'Notes', note: '1 copy, priority 3', size: 2048, icon: 'file'}]};

function navigationMock() {
  return {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
}

// every tree is unmounted after its test, so no refresh or toast timer outlives it
const mounted: ReturnType<typeof renderer.create>[] = [];

async function mount(route: any, navigation = navigationMock()) {
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

function press(tree: ReturnType<typeof renderer.create>, label: string) {
  const target = tree.root.findAll(
    (node: any) => node.type === Pressable && [node.props.accessibilityLabel, ...texts({root: node} as any)].includes(label),
  )[0];
  if (!target) {
    throw new Error(`nothing to press labelled ${label}`);
  }
  return act(async () => {
    await target.props.onPress();
  });
}

/**
 * A completely new Satellite's interface - navigation, data, buttons,
 * sliders, toggles, forms and the shared file browser - rendered from its
 * ui.json alone (UI contract 1.0, docs/ui-contract.md).
 */
describe('SatelliteUiScreen', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(tree => tree.unmount());
    });
  });

  beforeEach(() => {
    for (const mock of Object.values(__mocks)) {
      mock.mockReset();
    }
    __mocks.document.mockResolvedValue({document: SHOWCASE, revision: 'rev1', offline: false});
    __mocks.providers.mockResolvedValue({
      'files.browse': [{satellite: 'Files', version: 1, enabled: true, operations: {list: 'entries'}}],
    });
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route === 'summary') return SUMMARY;
      if (route === 'items') return ITEMS;
      if (route === 'items/7') return {...ITEMS.items[0], copies: 1, pinned: false, priority: 3};
      if (route.startsWith('entries?path=')) return {path: '', parent: null, entries: [{name: '/', type: 'dir', size: null}]};
      throw new Error(`unexpected route ${route}`);
    });
    __mocks.act.mockResolvedValue({message: 'Done'});
    (useDeveloperMode as jest.Mock).mockReturnValue({enabled: false});
  });

  it('draws the entry page from live data, with the document navigation as tabs', async () => {
    const {tree} = await mount({params: {name: 'Showcase', revision: 'rev1'}});
    expect(__mocks.document).toHaveBeenCalledWith('Showcase', 'rev1');
    expect(__mocks.read).toHaveBeenCalledWith('Showcase', 'summary');
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['Overview', 'Items', 'Files', 'LIVE DATA', '40%', '2m 5s', '3', 'Started']));
    // a developer-only block stays out of the way until Developer Mode is on
    expect(shown).not.toContain('0 items in memory');
  });

  it('shows developer blocks in Developer Mode', async () => {
    (useDeveloperMode as jest.Mock).mockReturnValue({enabled: true});
    const {tree} = await mount({params: {name: 'Showcase'}});
    expect(texts(tree)).toContain('0 items in memory');
  });

  it('hides and shows blocks through bindings', async () => {
    __mocks.read.mockResolvedValue({...SUMMARY, enabled: false, disabled: true});
    const {tree} = await mount({params: {name: 'Showcase'}});
    expect(texts(tree)).toContain('Turn on Enabled to change the counter.');
    expect(texts(tree)).not.toContain('Increment');
  });

  it('runs a button action against the Satellite route, then refreshes', async () => {
    const {tree} = await mount({params: {name: 'Showcase'}});
    __mocks.read.mockClear();
    await press(tree, 'Increment');
    expect(__mocks.act).toHaveBeenCalledWith('Showcase', 'counter/increment', 'POST', {});
    expect(__mocks.read).toHaveBeenCalledWith('Showcase', 'summary');
    expect(texts(tree)).toContain('Done');
  });

  it('asks first when an action says to, and does nothing on cancel', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style === 'cancel')?.onPress?.();
    });
    const {tree} = await mount({params: {name: 'Showcase'}});
    await press(tree, 'Reset');
    expect(alert).toHaveBeenCalledWith('Reset the counter, level and items?', undefined, expect.any(Array), expect.any(Object));
    expect(__mocks.act).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('sends a slider value once it is released, and a toggle value', async () => {
    const {tree} = await mount({params: {name: 'Showcase'}});
    await act(async () => {
      tree.root.findByType(Slider).props.onComplete(75);
    });
    expect(__mocks.act).toHaveBeenCalledWith('Showcase', 'settings', 'POST', {level: 75});
    await act(async () => {
      await tree.root.findByType(StarSwitch).props.onValueChange(false);
    });
    expect(__mocks.act).toHaveBeenCalledWith('Showcase', 'settings', 'POST', {enabled: false});
  });

  it('switches tabs in place and pushes a detail page with its params', async () => {
    const {tree, navigation} = await mount({params: {name: 'Showcase'}});
    await press(tree, 'Items');
    expect(navigation.setParams).toHaveBeenCalledWith({page: 'items', params: {}});

    const items = await mount({params: {name: 'Showcase', page: 'items', revision: 'rev1'}});
    expect(texts(items.tree)).toEqual(expect.arrayContaining(['Notes', '1 copy, priority 3', '2 KB']));
    await press(items.tree, 'Notes');
    expect(items.navigation.push).toHaveBeenCalledWith('SatelliteUi', {
      name: 'Showcase', page: 'item', params: {id: '7'}, revision: 'rev1',
    });
  });

  it('loads a detail page from its params and titles it from its data', async () => {
    const {navigation} = await mount({params: {name: 'Showcase', page: 'item', params: {id: '7'}}});
    expect(__mocks.read).toHaveBeenCalledWith('Showcase', 'items/7');
    expect(navigation.setOptions).toHaveBeenLastCalledWith({title: 'Notes'});
  });

  it('submits a form with its values and follows the result to the new page', async () => {
    __mocks.act.mockResolvedValue({id: '8', message: 'Added Plans'});
    const {tree, navigation} = await mount({params: {name: 'Showcase', page: 'items'}});
    await act(async () => {
      tree.root.findAllByType(TextInput)[0].props.onChangeText('Plans');
    });
    await press(tree, 'Add item');
    expect(__mocks.act).toHaveBeenCalledWith('Showcase', 'items', 'POST', {title: 'Plans', size: 'small', copies: 1, pinned: false});
    expect(navigation.push).toHaveBeenCalledWith('SatelliteUi', {name: 'Showcase', page: 'item', params: {id: '8'}, revision: undefined});
    // this page stays mounted behind the new one, so the form starts afresh here
    expect(tree.root.findAllByType(TextInput)[0].props.value).toBe('');
  });

  it('refuses to submit a form missing a required field', async () => {
    const {tree} = await mount({params: {name: 'Showcase', page: 'items'}});
    await press(tree, 'Add item');
    expect(__mocks.act).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('Title is required.');
  });

  it('browses through whichever Satellite provides files.browse', async () => {
    const {tree} = await mount({params: {name: 'Showcase', page: 'files'}});
    expect(__mocks.read).toHaveBeenCalledWith('Files', 'entries?path=');
    expect(texts(tree)).toContain('/');
  });

  it('says so when no Satellite provides the capability a block needs', async () => {
    __mocks.providers.mockResolvedValue({});
    const {tree} = await mount({params: {name: 'Showcase', page: 'files'}});
    expect(texts(tree).join(' ')).toContain('No enabled Satellite provides files.browse');
  });

  it('explains an incompatible or unloadable document instead of drawing it', async () => {
    __mocks.document.mockRejectedValue(new Error('This interface needs starcore.ui/2.0; update the app.'));
    const {tree} = await mount({params: {name: 'Showcase'}});
    expect(texts(tree)).toContain('This interface needs starcore.ui/2.0; update the app.');
  });

  it('skips a block it does not know, unless the page requires it', async () => {
    const document = {
      contract: 'starcore.ui/1.3',
      entry: 'home',
      pages: {home: {blocks: [{type: 'heading', text: 'Hello'}, {type: 'chart'}, {type: 'tabs', required: true}]}},
    };
    __mocks.document.mockResolvedValue({document, revision: 'r', offline: false});
    const {tree} = await mount({params: {name: 'Future'}});
    expect(texts(tree)).toEqual(expect.arrayContaining(['Hello', 'Part of this page needs a newer StarCore app.']));
  });
});
