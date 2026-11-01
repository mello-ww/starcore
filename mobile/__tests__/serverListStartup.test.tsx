/**
 * Every cold start opens the server list first, and nothing server-specific
 * (AuthProvider, therefore the lock screen, login screen or any StarCore
 * data) is mounted until a server is picked: Server List -> Select Server
 * -> Biometric Unlock / Login -> StarCore. Uses the real App, ServersGate,
 * ServersProvider and ServerListScreen on top of the AsyncStorage mock;
 * AuthProvider, RootNavigator, onboarding and the connect form are replaced
 * by markers that expose the props App hands them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {BackHandler, Text} from 'react-native';

jest.mock('react-native-gesture-handler', () => {
  const {View} = require('react-native');
  return {GestureHandlerRootView: View};
});
jest.mock('../src/photo/backgroundSyncTask', () => ({
  configureBackgroundFetch: jest.fn(() => Promise.resolve()),
  triggerForegroundSync: jest.fn(),
}));
// the real provider renders nothing until the native side reports insets
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({children}: {children: React.ReactNode}) => children,
}));

const mockAuthMounts: string[] = [];
const mockAuthUnmounts: string[] = [];
jest.mock('../src/auth/AuthContext', () => {
  const ReactLib = require('react');
  const {View} = require('react-native');
  return {
    AuthProvider: ({children, serverId}: {children: React.ReactNode; serverId: string}) => {
      ReactLib.useEffect(() => {
        mockAuthMounts.push(serverId);
        return () => {
          mockAuthUnmounts.push(serverId);
        };
      }, [serverId]);
      return ReactLib.createElement(View, {testID: `auth-${serverId}`}, children);
    },
  };
});
jest.mock('../src/navigation/RootNavigator', () => {
  const ReactLib = require('react');
  const {Text: RNText} = require('react-native');
  return {
    RootNavigator: (props: any) => {
      (globalThis as any).mockRootProps = props;
      return ReactLib.createElement(RNText, {testID: 'root-navigator'}, 'root');
    },
  };
});
jest.mock('../src/navigation/OnboardingNavigator', () => {
  const ReactLib = require('react');
  const {Text: RNText} = require('react-native');
  return {
    OnboardingNavigator: (props: any) => {
      (globalThis as any).mockOnboardingProps = props;
      return ReactLib.createElement(RNText, {testID: 'onboarding'}, 'onboarding');
    },
  };
});
jest.mock('../src/screens/ConnectScreen', () => {
  const ReactLib = require('react');
  const {Text: RNText} = require('react-native');
  return {
    ConnectScreen: (props: any) => {
      (globalThis as any).mockConnectProps = props;
      return ReactLib.createElement(RNText, {testID: 'connect-screen'}, 'connect');
    },
  };
});

import App from '../src/App';

const SERVERS = [
  {id: 'srv-a', name: 'Home', baseUrl: 'http://192.168.1.10:8090'},
  {id: 'srv-b', name: 'Office', baseUrl: 'http://10.0.0.5:8090'},
];

const root = () => (globalThis as any).mockRootProps;
const connect = () => (globalThis as any).mockConnectProps;

const mounted: any[] = [];

async function seed(servers = SERVERS, lastId: string | null = 'srv-b') {
  await AsyncStorage.clear();
  if (servers.length) {
    await AsyncStorage.setItem('starcore_servers', JSON.stringify(servers));
  }
  if (lastId) {
    await AsyncStorage.setItem('starcore_active_server_id', lastId);
  }
}

async function coldStart() {
  let tree!: any;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
  mounted.push(tree);
  return tree;
}

const has = (tree: any, testID: string) =>
  tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string').length > 0;

const allText = (tree: any) =>
  tree.root
    .findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat()
    .join(' ');

function press(tree: any, testID: string) {
  const node = tree.root.findAll((n: any) => n.props.testID === testID && n.props.onPress)[0];
  return act(async () => {
    await node.props.onPress();
  });
}

function pressTitle(tree: any, title: string) {
  let node: any = tree.root.findAll((n: any) => n.type === Text && n.props.children === title)[0];
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  return act(async () => {
    await node.props.onPress();
  });
}

async function unmountAll() {
  await act(async () => {
    mounted.splice(0).forEach(tree => tree.unmount());
  });
}

beforeEach(() => {
  mockAuthMounts.length = 0;
  mockAuthUnmounts.length = 0;
});
afterEach(unmountAll);

describe('cold start', () => {
  it('shows the server list first, even though a server was used last time', async () => {
    await seed();

    const tree = await coldStart();

    expect(has(tree, 'server-list-screen')).toBe(true);
    expect(has(tree, 'server-row-srv-a')).toBe(true);
    expect(has(tree, 'server-row-srv-b')).toBe(true);
    expect(allText(tree)).toMatch(/LAST USED/);
  });

  it('mounts nothing server-specific before a server is chosen', async () => {
    await seed();

    const tree = await coldStart();

    expect(mockAuthMounts).toEqual([]); // no AuthProvider => no lock screen, login or protected data
    expect(has(tree, 'root-navigator')).toBe(false);
  });

  it('shows the list on every cold start, not only the first', async () => {
    await seed();

    for (let launch = 0; launch < 3; launch += 1) {
      const tree = await coldStart();
      expect(has(tree, 'server-list-screen')).toBe(true);
      expect(mockAuthMounts).toEqual([]);
      await press(tree, 'server-row-srv-a');
      expect(mockAuthMounts).toEqual(['srv-a']);
      await unmountAll();
      mockAuthMounts.length = 0;
    }
  });

  it('goes to onboarding when no server is configured', async () => {
    await seed([], null);

    const tree = await coldStart();

    expect(has(tree, 'onboarding')).toBe(true);
    expect(has(tree, 'server-list-screen')).toBe(false);
  });

  it('ignores a stored last-used server that no longer exists', async () => {
    await seed(SERVERS, 'srv-gone');

    const tree = await coldStart();

    expect(has(tree, 'server-list-screen')).toBe(true);
    expect(allText(tree)).not.toMatch(/LAST USED/);
  });
});

describe('selecting servers', () => {
  it('opens only the chosen server', async () => {
    await seed();
    const tree = await coldStart();

    await press(tree, 'server-row-srv-a');

    expect(mockAuthMounts).toEqual(['srv-a']);
    expect(has(tree, 'auth-srv-a')).toBe(true);
    expect(has(tree, 'root-navigator')).toBe(true);
    expect(has(tree, 'server-list-screen')).toBe(false);
  });

  it('Back from the lock screen returns to the server list and leaves everything stored alone', async () => {
    await seed();
    const tree = await coldStart();
    await press(tree, 'server-row-srv-a');

    await act(async () => root().onBackToServerList());

    expect(has(tree, 'server-list-screen')).toBe(true);
    expect(has(tree, 'auth-srv-a')).toBe(false);
    expect(mockAuthUnmounts).toEqual(['srv-a']);
    expect(JSON.parse((await AsyncStorage.getItem('starcore_servers'))!)).toEqual(SERVERS);
  });

  it('Back from an ordinary login screen returns to the server list', async () => {
    await seed();
    const tree = await coldStart();
    await press(tree, 'server-row-srv-b');

    expect(root().onBackToServerAddress).toBeDefined(); // the login screen always gets a Back action
    await act(async () => root().onBackToServerAddress());

    expect(has(tree, 'server-list-screen')).toBe(true);
    expect(JSON.parse((await AsyncStorage.getItem('starcore_servers'))!)).toEqual(SERVERS);
  });

  it('switches between two protected servers through the list, each mounted on its own', async () => {
    await seed();
    const tree = await coldStart();

    await press(tree, 'server-row-srv-a');
    await act(async () => root().onBackToServerList());
    await press(tree, 'server-row-srv-b');

    expect(mockAuthMounts).toEqual(['srv-a', 'srv-b']);
    expect(mockAuthUnmounts).toEqual(['srv-a']);
    expect(has(tree, 'auth-srv-b')).toBe(true);
    expect(has(tree, 'auth-srv-a')).toBe(false);
    expect(await AsyncStorage.getItem('starcore_active_server_id')).toBe('srv-b'); // remembered as last used only
  });
});

describe('adding a server from the list', () => {
  it('opens the add form with a working Back and hardware back', async () => {
    await seed();
    const addListener = jest.spyOn(BackHandler, 'addEventListener');
    const tree = await coldStart();

    await pressTitle(tree, 'Add server');
    expect(has(tree, 'connect-screen')).toBe(true);

    await act(async () => connect().onBack());
    expect(has(tree, 'server-list-screen')).toBe(true);

    await pressTitle(tree, 'Add server');
    const hardwareBack = addListener.mock.calls[addListener.mock.calls.length - 1][1];
    await act(async () => {
      expect(hardwareBack()).toBe(true);
    });
    expect(has(tree, 'server-list-screen')).toBe(true);
    addListener.mockRestore();
  });

  it('backing out of the new server\'s login returns to its add form, without opening another server', async () => {
    await seed();
    const tree = await coldStart();
    await pressTitle(tree, 'Add server');

    await act(async () => connect().onConnect('Cabin', 'http://10.1.1.1:8090'));
    expect(mockAuthMounts).toHaveLength(1); // the new server's login
    const newId = mockAuthMounts[0];
    expect(newId).not.toBe('srv-a');

    await act(async () => root().onBackToServerAddress());

    expect(has(tree, 'connect-screen')).toBe(true);
    expect(connect().initialName).toBe('Cabin'); // what was typed is kept
    expect(connect().initialAddress).toBe('http://10.1.1.1:8090');
    expect(mockAuthMounts).toHaveLength(1); // no existing server was auto-opened
    const stored = JSON.parse((await AsyncStorage.getItem('starcore_servers'))!);
    expect(stored).toEqual(SERVERS); // the half-added server is gone, the others untouched

    await act(async () => connect().onBack());
    expect(has(tree, 'server-list-screen')).toBe(true);
  });
});
