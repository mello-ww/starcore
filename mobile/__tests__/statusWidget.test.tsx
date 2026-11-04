import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {HomeScreen} from '../src/screens/HomeScreen';
import {StatusWidget} from '../src/status/StatusWidget';
import {AccentProvider} from '../src/theme/AccentContext';
import {tokens} from '../src/theme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 24, bottom: 0, left: 0, right: 0}),
}));
jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const navigation = {navigate: jest.fn()};
  return {
    useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]),
    useIsFocused: () => true,
    useNavigation: () => navigation,
    __navigation: navigation,
  };
});
jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));
jest.mock('../src/satellites/api', () => {
  const list = jest.fn();
  return {SatellitesApi: jest.fn().mockImplementation(() => ({list})), __mocks: {list}};
});

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';
const {__mocks} = jest.requireMock('../src/satellites/api') as {__mocks: {list: jest.Mock}};
const {__navigation} = jest.requireMock('@react-navigation/native') as {__navigation: {navigate: jest.Mock}};

const statusState = {
  health: 'warning',
  cpu_percent: 94.2,
  memory_percent: 75,
  satellites_online: 5,
  satellites_total: 6,
  warnings: ['CPU is busy', 'D:\\ is almost full', 'Music is not running'],
  warning_count: 4,
  platform: 'Windows',
  python: '3.14.7',
};
const status = {
  name: 'Status', version: '1', author: 'a', description: 'System monitoring satellite.', icon: 'icon.svg',
  type: 'native' as const, enabled: true, status: 'running' as const, configurable: false, mobile_ui: true,
  state: statusState,
};
const music = {
  name: 'Music', version: '1', author: 'a', description: 'Local music library satellite.', icon: 'icon.svg',
  type: 'native' as const, enabled: true, status: 'running' as const, configurable: true, mobile_ui: true,
};

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
}

function fills(tree: Tree): string[] {
  return tree.root
    .findAllByProps({accessibilityRole: 'progressbar'}, {deep: false})
    .map((meter: any) => StyleSheet.flatten(meter.findAllByType(require('react-native').View)[1]?.props.style)?.backgroundColor);
}

describe('StatusWidget', () => {
  it('shows health, CPU, RAM, satellites and the first warnings', () => {
    let tree!: Tree;
    act(() => {
      tree = renderer.create(<StatusWidget satellite={status} onOpen={() => {}} />);
    });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['STATUS', 'Warning', '94.2%', '75%', '5/6', 'CPU is busy', 'D:\\ is almost full', '+2 more']));
    expect(shown).not.toContain('Music is not running');
  });

  it('colours its bars by severity, never with the accent', () => {
    let tree!: Tree;
    act(() => {
      tree = renderer.create(<StatusWidget satellite={status} onOpen={() => {}} />);
    });
    expect(fills(tree)).toEqual([tokens.palette.warn, tokens.palette.textIcon]);
  });

  it('is hidden without a Status satellite, when it is disabled, or on an older server', () => {
    for (const satellite of [undefined, {...status, enabled: false}, {...status, state: {platform: 'Windows'}}]) {
      let tree!: Tree;
      act(() => {
        tree = renderer.create(<StatusWidget satellite={satellite} onOpen={() => {}} />);
      });
      expect(tree.toJSON()).toBeNull();
    }
  });
});

describe('HomeScreen Status card', () => {
  const client = {
    get: jest.fn((path: string) =>
      Promise.resolve(
        path === '/api/auth/status'
          ? {status: 200, body: {authenticated: true, username: 'Ada'}}
          : {status: 200, body: {engine: 'StarCore', running: true, uptime_seconds: 3720, commands: 7}},
      ),
    ),
  };

  async function render(): Promise<Tree> {
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(
        <AccentProvider>
          <HomeScreen />
        </AccentProvider>,
      );
    });
    return tree;
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    __navigation.navigate.mockReset();
    client.get.mockClear();
    (useAuth as jest.Mock).mockReturnValue({client});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'srv-1', name: 'Atlas'}});
  });

  it('reads the summary from the satellite listing Home already loads, and opens Status', async () => {
    __mocks.list.mockReset().mockResolvedValue([music, status]);
    const tree = await render();
    expect(tree.root.findAllByProps({testID: 'home-status-widget'}, {deep: false})).toHaveLength(1);
    // no extra request: only the auth status and the engine status besides the listing
    expect(client.get.mock.calls.map(call => call[0]).sort()).toEqual(['/api/auth/status', '/api/status']);
    act(() => tree.root.findByProps({testID: 'home-status-widget'}).props.onPress());
    expect(__navigation.navigate).toHaveBeenCalledWith('Satellites', {screen: 'StatusHome', params: undefined, initial: false});
  });

  it('opens the native Status screen from the Status satellite card too', async () => {
    __mocks.list.mockReset().mockResolvedValue([music, status]);
    const tree = await render();
    act(() => tree.root.findByProps({accessibilityLabel: 'Open Status'}).props.onPress());
    expect(__navigation.navigate).toHaveBeenCalledWith('Satellites', {screen: 'StatusHome', params: undefined, initial: false});
  });

  it('leaves Status to its ui.json widget once the server ships one', async () => {
    __mocks.list.mockReset().mockResolvedValue([music, {...status, ui: {contract: 'starcore.ui/1.1', revision: 'r1', error: null}}]);
    const tree = await render();
    expect(tree.root.findAllByProps({testID: 'home-status-widget'}, {deep: false})).toHaveLength(0);
  });

  it('shows no Status card when the server has no Status satellite', async () => {
    __mocks.list.mockReset().mockResolvedValue([music]);
    const tree = await render();
    expect(tree.root.findAllByProps({testID: 'home-status-widget'}, {deep: false})).toHaveLength(0);
  });
});
