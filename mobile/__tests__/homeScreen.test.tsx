import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {HomeScreen, alertsFor, formatUptime, greeting} from '../src/screens/HomeScreen';
import {ACCENT_STORAGE_KEY, AccentProvider, useAccent} from '../src/theme/AccentContext';

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

const music = {
  name: 'Music', version: '1', author: 'a', description: 'Local music library satellite.', icon: 'icon.svg',
  type: 'native' as const, enabled: true, status: 'running' as const, configurable: true, mobile_ui: true,
};
const docker = {
  name: 'docker', version: '1', author: 'a', description: 'Containers', icon: null,
  type: 'link' as const, enabled: true, status: 'stopped' as const, configurable: false, mobile_ui: false,
};

function clientWith(username: string | null, statusCode = 200) {
  return {
    get: jest.fn((path: string) => {
      if (path === '/api/auth/status') {
        return Promise.resolve({status: 200, body: username === null ? {authenticated: true} : {authenticated: true, username}});
      }
      return Promise.resolve({status: statusCode, body: {engine: 'StarCore', running: true, uptime_seconds: 3720, commands: 7}});
    }),
  };
}

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
}

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

describe('HomeScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    __mocks.list.mockReset().mockResolvedValue([music, docker]);
    __navigation.navigate.mockReset();
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'srv-1', name: 'Atlas'}});
  });

  it('greets the signed-in account by name', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith('Ada')});
    const tree = await render();
    expect(texts(tree)).toContain('Ravi de vous revoir, Ada');
  });

  it('falls back to a nameless greeting when the server reports no name', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith(null)});
    const tree = await render();
    expect(texts(tree)).toContain('Ravi de vous revoir');
  });

  it('shows the live status, the satellites and real alerts', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith('Ada')});
    const tree = await render();
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['Online', '1h 2m', '1/2', '7', 'Music', 'docker']));
    expect(shown).toContain('docker is enabled but not running');
    expect(shown).toContain('No mobile interface yet');
  });

  it('opens a satellite inside the Satellites tab', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith('Ada')});
    const tree = await render();
    act(() => tree.root.findByProps({accessibilityLabel: 'Open Music'}).props.onPress());
    expect(__navigation.navigate).toHaveBeenCalledWith('Satellites', {screen: 'MusicHome', params: undefined, initial: false});
  });

  it('shows an error state with a retry when the server is unreachable', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith('Ada', 502)});
    const tree = await render();
    expect(texts(tree)).toEqual(expect.arrayContaining(['Unreachable', 'Could not reach this StarCore server.', 'Try again']));
  });

  it('saves the accent picked from the header', async () => {
    (useAuth as jest.Mock).mockReturnValue({client: clientWith('Ada')});
    const tree = await render();
    act(() => tree.root.findByProps({accessibilityLabel: 'Accent colour', accessibilityRole: 'button'}).props.onPress());
    await act(async () => tree.root.findByProps({testID: 'accent-blue'}).props.onPress());
    expect(await AsyncStorage.getItem(ACCENT_STORAGE_KEY)).toBe('blue');
  });
});

describe('AccentProvider', () => {
  it('restores the saved accent and ignores unknown values', async () => {
    let seen = '';
    function Probe() {
      seen = useAccent().accent;
      return null;
    }

    await AsyncStorage.setItem(ACCENT_STORAGE_KEY, 'green');
    await act(async () => {
      renderer.create(
        <AccentProvider>
          <Probe />
        </AccentProvider>,
      );
    });
    expect(seen).toBe('green');

    await AsyncStorage.setItem(ACCENT_STORAGE_KEY, 'chartreuse');
    await act(async () => {
      renderer.create(
        <AccentProvider>
          <Probe />
        </AccentProvider>,
      );
    });
    expect(seen).toBe('red');
  });
});

describe('Home helpers', () => {
  it('formats greetings, uptime and alerts', () => {
    expect(greeting('')).toBe('Ravi de vous revoir');
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(600)).toBe('10m');
    expect(alertsFor([music, {...docker, status: 'disabled' as const}])).toEqual([]);
    expect(alertsFor([{...music, status: 'error' as const}])[0].text).toBe('Music reported an error');
  });
});
