import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text} from 'react-native';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {SatelliteWidgets} from '../src/satellites/ui/Widgets';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn(() => ({client: {}}))}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});

import {useDeveloperMode} from '../src/developer/DeveloperModeContext';
import {UiApi} from '../src/satellites/ui/api';
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {
  __mocks: {document: jest.Mock; providers: jest.Mock; read: jest.Mock; act: jest.Mock};
};

// Status's real document (satellites/native/status/ui.json) and a synthetic
// answer from its view and history routes (generated from the Engine test
// suite's fake hardware): the shared screen has no idea what Status is
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};
const STATUS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'satellites', 'native', 'status', 'ui.json'), 'utf-8'));
const {view: VIEW, history: HISTORY} = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'status-view.json'), 'utf-8'));

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

describe('Status, drawn from its ui.json by the shared screen', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(tree => tree.unmount());
    });
  });

  beforeEach(() => {
    for (const mock of Object.values(__mocks)) {
      mock.mockReset();
    }
    (useDeveloperMode as jest.Mock).mockReturnValue({enabled: false});
    __mocks.document.mockResolvedValue({document: STATUS, revision: 'rev1', offline: false});
    __mocks.providers.mockResolvedValue({});
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => {
      if (route === 'view') return VIEW;
      if (route.startsWith('history')) return HISTORY;
      throw new Error(`unexpected route ${route}`);
    });
  });

  it('shows the header, warnings, tiles and the last hour', async () => {
    const {tree} = await mount({params: {name: 'Status', revision: 'rev1'}});
    const shown = texts(tree);
    expect(shown).toContain('STATUS · TEST-HOST');
    expect(shown).toContain('System status');
    expect(shown).toContain('Warning');
    expect(shown).toEqual(expect.arrayContaining(['CPU', 'MEMORY', 'STORAGE', 'NETWORK', 'SATELLITES', 'UPTIME']));
    expect(shown).toContain(VIEW.warnings[0].title);
    expect(shown).toContain('CPU · LAST HOUR');
    // the page's data, the header's and the trend - each from the Satellite's own routes
    const routes = __mocks.read.mock.calls.map(call => call[1]);
    expect(routes).toEqual(expect.arrayContaining(['view', 'history?period=1h&series=cpu%2Cmemory%2Cnet_rx%2Cnet_tx&points=120']));
    expect(tree.root.findAllByProps({testID: 'sparkline'}).length).toBeGreaterThan(0);
  });

  it('keeps Diagnostics for Developer Mode', async () => {
    const {tree} = await mount({params: {name: 'Status', revision: 'rev1'}});
    expect(tree.root.findAllByProps({testID: 'ui-tab-diagnostics'})).toHaveLength(0);
    expect(tree.root.findAllByProps({testID: 'ui-tab-history'}).length).toBeGreaterThan(0);

    (useDeveloperMode as jest.Mock).mockReturnValue({enabled: true});
    const second = await mount({params: {name: 'Status', revision: 'rev1'}});
    expect(second.tree.root.findAllByProps({testID: 'ui-tab-diagnostics'}).length).toBeGreaterThan(0);
  });

  it('draws tables as rows of labelled values', async () => {
    const {tree} = await mount({params: {name: 'Status', page: 'hardware', revision: 'rev1'}});
    const shown = texts(tree);
    for (const partition of VIEW.hardware.storage.partitions) {
      expect(shown).toContain(partition.drive);
    }
    expect(shown).toEqual(expect.arrayContaining(['FILE SYSTEM', 'USED', 'SIZE', 'FREE']));
    expect(shown).toContain(VIEW.hardware.cpu.model);
  });

  it('asks for the period a choice selects', async () => {
    const {tree} = await mount({params: {name: 'Status', page: 'history', revision: 'rev1'}});
    expect(__mocks.read.mock.calls.map(call => call[1])).toContain('history?period=24h&points=360');
    await press(tree, '7 days');
    expect(__mocks.read.mock.calls.map(call => call[1])).toContain('history?period=7d&points=360');
    const selected = tree.root.findAll((node: any) => node.props.testID === 'ui-choice-7d' && node.props.accessibilityState);
    expect(selected[0].props.accessibilityState).toEqual({selected: true});
  });

  it('keeps the last reading, marked offline, when StarCore stops answering', async () => {
    const {tree} = await mount({params: {name: 'Status', revision: 'rev1'}});
    __mocks.read.mockRejectedValue(new Error('StarCore did not answer'));
    const {RefreshControl} = require('react-native');
    await act(async () => {
      await tree.root.findByType(RefreshControl).props.onRefresh();
    });
    expect(tree.root.findAllByProps({testID: 'ui-stale'}).length).toBeGreaterThan(0);
    expect(texts(tree)).toContain('Offline');
    expect(texts(tree)).toContain('CPU'); // the last reading is still there
  });

  it('does not call an error answer offline', async () => {
    const {tree} = await mount({params: {name: 'Status', revision: 'rev1'}});
    const {ApiError} = require('../src/api/types');
    __mocks.read.mockRejectedValue(new ApiError('Something broke on the server.', 500));
    const {RefreshControl} = require('react-native');
    await act(async () => {
      await tree.root.findByType(RefreshControl).props.onRefresh();
    });
    expect(tree.root.findAllByProps({testID: 'ui-stale'}).length).toBeGreaterThan(0);
    expect(texts(tree)).toContain('Not refreshed');
    expect(texts(tree)).not.toContain('Offline');
  });

  it('says so, with a way to try again, when the first reading fails', async () => {
    __mocks.read.mockRejectedValue(new Error('StarCore did not answer'));
    const {tree} = await mount({params: {name: 'Status', page: 'hardware', revision: 'rev1'}});
    expect(texts(tree)).toContain('Status is unavailable');
    __mocks.read.mockImplementation(async (_satellite: string, route: string) => (route === 'view' ? VIEW : HISTORY));
    await act(async () => {
      await tree.root.findByProps({testID: 'ui-retry'}).props.onPress();
    });
    expect(texts(tree)).toContain(VIEW.hardware.cpu.model);
  });
});

describe('Home widgets', () => {
  beforeEach(() => {
    for (const mock of Object.values(__mocks)) {
      mock.mockReset();
    }
    __mocks.document.mockResolvedValue({document: STATUS, revision: 'rev1', offline: false});
  });

  const state = {
    health: 'warning', cpu_percent: 42.5, memory_percent: 91.2, satellites_online: 3, satellites_total: 4,
    warnings: ['Memory is almost full'], warning_count: 1,
    health_label: 'Warning', health_tone: 'warn', health_detail: '1 warning', cpu_tone: 'neutral', memory_tone: 'warn',
    satellites: '3/4', warning_items: [{title: 'Memory is almost full', tone: 'warn'}],
  };
  const satellite: any = {name: 'Status', enabled: true, status: 'running', ui: {contract: 'starcore.ui/1.1', revision: 'rev1', error: null}, state};

  it('draws every Satellite\'s widgets from the state it already publishes', async () => {
    const onOpen = jest.fn();
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(
        <SatelliteWidgets satellites={[satellite]} api={new (UiApi as any)()} developer={false} onOpen={onOpen} />,
      );
    });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['STATUS', 'Warning', '1 warning', 'CPU', '42.5%', 'RAM', '91.2%', '3/4']));
    expect(shown).toContain('Memory is almost full');
    expect(__mocks.read).not.toHaveBeenCalled(); // no request of its own
    await act(async () => {
      tree.root.findByProps({testID: 'home-widget-health'}).props.onPress();
    });
    expect(onOpen).toHaveBeenCalledWith(satellite, 'overview', {});
    act(() => tree.unmount());
  });

  it('shows nothing for a Satellite that publishes nothing', async () => {
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(
        <SatelliteWidgets satellites={[{...satellite, state: {}}]} api={new (UiApi as any)()} developer={false} onOpen={jest.fn()} />,
      );
    });
    expect(tree.root.findAllByProps({testID: 'home-widget-health'})).toHaveLength(0);
    act(() => tree.unmount());
  });
});
