import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Modal, StyleSheet} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {AudioHost, useAudioHost} from '../src/media/AudioHost';
import {FullPlayer} from '../src/media/ui/FullPlayer';
import {TOUCH_TARGET} from '../src/theme';
import {makeTracks, preferences, testCatalog} from './audioFakes';

// Insets exist only inside a provider, like a Modal window: the root provider of a non
// edge-to-edge activity reports none, which is exactly what made the player draw under the
// status bar.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const Insets = React.createContext({top: 0, bottom: 0, left: 0, right: 0});
  return {
    SafeAreaProvider: ({children}: {children: React.ReactNode}) =>
      React.createElement(Insets.Provider, {value: {top: 40, bottom: 30, left: 0, right: 0}}, children),
    useSafeAreaInsets: () => React.useContext(Insets),
  };
});
jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';

function client() {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/api/catalog') {
        return {status: 200, body: {capabilities: testCatalog}};
      }
      if (path.endsWith('/preferences')) {
        return {status: 200, body: preferences};
      }
      if (path.endsWith('/favorites')) {
        return {status: 200, body: {ids: {track: []}, tracks: [], albums: [], artists: []}};
      }
      return {status: 500, body: {}};
    }),
    post: jest.fn(async () => ({status: 200, body: {cursor: 0}})),
  };
}

let host!: ReturnType<typeof useAudioHost>;
function Probe() {
  host = useAudioHost();
  return null;
}

const flat = (node: any) => StyleSheet.flatten(node.props.style) ?? {};

const mounted: ReturnType<typeof renderer.create>[] = [];

async function mountPlayer() {
  (useAuth as jest.Mock).mockReturnValue({client: client(), state: {status: 'signed-in', session: {token: 't'}}, locked: false});
  (useServers as jest.Mock).mockReturnValue({activeServer: {id: 's', baseUrl: 'https://s.test'}});
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(
      <AudioHost>
        <Probe />
        <FullPlayer />
      </AudioHost>,
    );
  });
  await act(async () => {
    await host.player.playTracks(makeTracks(2), 0);
    host.setFullPlayer(true);
  });
  mounted.push(tree);
  return tree;
}

describe('The shared player safe areas', () => {
  beforeEach(() => AsyncStorage.clear());
  afterEach(() => {
    act(() => mounted.splice(0).forEach(tree => tree.unmount()));
  });

  it('keeps the full-screen player clear of the status bar and the gesture bar', async () => {
    const tree = await mountPlayer();
    const close = tree.root.findByProps({accessibilityLabel: 'Close the player'});
    const screen = close.parent!.parent!.parent!;
    const style = flat(screen);

    expect(tree.root.findByType(Modal).props.visible).toBe(true);
    expect(style.paddingTop).toBeGreaterThanOrEqual(40);
    expect(style.paddingBottom).toBeGreaterThanOrEqual(30);
  });

  it('gives every player control at least a 48 dp touch target', async () => {
    const tree = await mountPlayer();
    for (const label of ['Close the player', 'Like', 'Shuffle', 'Previous', 'Next']) {
      const style = flat(tree.root.findByProps({accessibilityLabel: label}));
      expect(style.minWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    const play = flat(tree.root.findAll((node: {props: Record<string, unknown>}) => ['Play', 'Pause'].includes(String(node.props.accessibilityLabel)))[0]);
    expect(play.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });
});
