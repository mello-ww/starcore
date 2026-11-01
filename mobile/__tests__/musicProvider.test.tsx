import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MusicProvider, useMusic, usePlayerState} from '../src/music/MusicProvider';
import {musicKeys} from '../src/music/storage';
import {SatellitesListScreen} from '../src/screens/SatellitesListScreen';
import {makeTracks, preferences} from './musicFakes';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));
jest.mock('../src/satellites/cache');
jest.mock('../src/satellites/api', () => {
  const list = jest.fn();
  return {SatellitesApi: jest.fn().mockImplementation(() => ({list})), __mocks: {list}};
});

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';
import {getCachedSatellites} from '../src/satellites/cache';
const {__mocks} = jest.requireMock('../src/satellites/api') as {__mocks: {list: jest.Mock}};

function client() {
  return {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/preferences')) {
        return {status: 200, body: preferences};
      }
      if (path.endsWith('/favorites')) {
        return {status: 200, body: {ids: {track: []}, tracks: [], albums: [], artists: []}};
      }
      if (path.includes('/playback/')) {
        return {status: 500, body: {}};
      }
      return {status: 200, body: {events: [], cursor: 0}};
    }),
    post: jest.fn(async () => ({status: 200, body: {cursor: 0}})),
  };
}

let captured: ReturnType<typeof useMusic> | null = null;
function Probe() {
  captured = useMusic();
  usePlayerState();
  return null;
}

async function mount(serverId: string, locked = false) {
  (useAuth as jest.Mock).mockReturnValue({client: client(), state: {status: 'signed-in', session: {token: `token-${serverId}`}}, locked});
  (useServers as jest.Mock).mockReturnValue({activeServer: {id: serverId, baseUrl: `https://${serverId}.test`}});
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<MusicProvider key={serverId}><Probe /></MusicProvider>);
  });
  return tree;
}

describe('MusicProvider', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    captured = null;
  });

  it('plays through one hidden player that carries the session as a header, with background playback on', async () => {
    const tree = await mount('server-a');
    await act(async () => {
      await captured!.player.playTracks(makeTracks(2), 0);
    });
    const video = tree.root.findByProps({testID: 'music-video'});
    expect(video.props.source.uri).toContain('https://server-a.test/api/satellites/music/stream/');
    expect(video.props.source.uri).not.toContain('token');
    expect(video.props.source.headers).toEqual({Authorization: 'Bearer token-server-a'});
    expect(video.props.playInBackground).toBe(true);
    expect(video.props.showNotificationControls).toBe(true);
    expect(video.props.disableFocus).toBeUndefined();
    expect(video.props.paused).toBe(false);
    tree.unmount();
  });

  it('keeps playing while the biometric lock covers the UI - it never reads the lock', async () => {
    const tree = await mount('server-a', true);
    await act(async () => {
      await captured!.player.playTracks(makeTracks(1), 0);
    });
    expect(tree.root.findByProps({testID: 'music-video'}).props.paused).toBe(false);
    tree.unmount();
  });

  it('restores only the active server’s queue, never another server’s', async () => {
    const tracks = makeTracks(2);
    await AsyncStorage.setItem(musicKeys.queue('server-a'), JSON.stringify({
      tracks, order: [0, 1], position: 1, shuffle: false, repeat: 'off', seconds: 12, context: null}));
    const first = await mount('server-a');
    expect(captured!.player.state.track?.id).toBe(tracks[1].id);
    expect(captured!.player.state.playing).toBe(false);
    first.unmount();

    const second = await mount('server-b');
    expect(captured!.player.state.track).toBeNull();
    expect(captured!.serverId).toBe('server-b');
    second.unmount();
  });
});

describe('SatellitesListScreen and Music', () => {
  it('opens the dedicated Music screens', async () => {
    (getCachedSatellites as jest.Mock).mockResolvedValue(null);
    (useAuth as jest.Mock).mockReturnValue({client: {}});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'srv-1', name: 'Home'}});
    __mocks.list.mockResolvedValue([{name: 'Music', version: '1', author: 'a', description: 'Music', icon: null,
      type: 'native', enabled: true, status: 'running', configurable: true, mobile_ui: true}]);
    const navigation = {navigate: jest.fn()} as any;
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={{} as any} />);
    });
    act(() => tree.root.findByProps({disabled: false}).props.onPress());
    expect(navigation.navigate).toHaveBeenCalledWith('MusicHome');
  });
});
