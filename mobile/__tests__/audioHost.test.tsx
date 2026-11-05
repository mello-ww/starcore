import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AudioHost, useAudioHost} from '../src/media/AudioHost';
import {AudioLibraryClient, resolveAudioProvider, type Catalog} from '../src/media/library';
import {PlayerController} from '../src/media/player';
import {fakeEffects, makeTracks, preferences, testProvider} from './musicFakes';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';

// A provider the app knows nothing about: its name is only in this test, its routes are its own.
const radio = {satellite: 'Radio', version: 1, enabled: true,
               operations: {search: 'find', track: 'item', resolve: 'tune', artwork: 'cover'}};

describe('resolveAudioProvider', () => {
  it('takes the first enabled provider of a version it knows, with that Satellite\'s session', () => {
    const catalog: Catalog = {
      'audio.library': [{...radio, satellite: 'Off', enabled: false}, {...radio, version: 2}, radio,
                        {...radio, satellite: 'Later'}],
      'audio.session': [{satellite: 'Later', version: 1, enabled: true, operations: {queue: 'queue'}}],
    };
    expect(resolveAudioProvider(catalog)).toEqual({satellite: 'Radio', operations: radio.operations, session: {}});
    catalog['audio.session']!.push({satellite: 'Radio', version: 1, enabled: true, operations: {history: 'log'}});
    expect(resolveAudioProvider(catalog)?.session).toEqual({history: 'log'});
  });

  it('falls back only for a server whose catalog lists no audio library at all', () => {
    expect(resolveAudioProvider(null, testProvider)).toBe(testProvider);
    expect(resolveAudioProvider({}, testProvider)).toBe(testProvider);
    // a server that lists providers, none usable: nothing to play, rather than a guess
    expect(resolveAudioProvider({'audio.library': [{...radio, enabled: false}]}, testProvider)).toBeNull();
  });
});

function client(catalog: Catalog) {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/api/catalog') {
        return {status: 200, body: {capabilities: catalog}};
      }
      const tune = /^\/api\/satellites\/Radio\/tune\/([^?]+)/.exec(path);
      if (tune) {
        return {status: 200, body: {track: {}, plan: null, stream: `listen/${tune[1]}`, gain: {db: 0}}};
      }
      return {status: 404, body: {}};
    }),
    post: jest.fn(async () => ({status: 404, body: {}})),
  };
}

let captured: ReturnType<typeof useAudioHost> | null = null;
function Probe() {
  captured = useAudioHost();
  return null;
}

describe('AudioHost', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    captured = null;
  });

  it('plays from an independently declared audio.library provider, found only through the catalog', async () => {
    const http = client({'audio.library': [radio]});
    (useAuth as jest.Mock).mockReturnValue({client: http, state: {status: 'signed-in', session: {token: 'token-a'}}});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'server-a', baseUrl: 'https://server-a.test'}});
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<AudioHost><Probe /></AudioHost>);
    });
    expect(captured!.provider?.satellite).toBe('Radio');
    const [track] = makeTracks(1);
    await act(async () => {
      await captured!.player.playTracks([track], 0);
    });
    const video = tree.root.findByProps({testID: 'music-video'});
    expect(video.props.source.uri).toBe(`https://server-a.test/api/satellites/Radio/listen/${track.id}`);
    expect(video.props.source.headers).toEqual({Authorization: 'Bearer token-a'});
    // no session: no Connect, and nothing asked of routes the provider never declared
    expect(captured!.connect).toBeNull();
    const asked = http.get.mock.calls.map(([path]) => path);
    expect(asked.filter(path => !path.startsWith('/api/satellites/Radio/tune/') && path !== '/api/catalog')).toEqual([]);
    expect(captured!.library.offers('lyrics')).toBe(false);
    tree.unmount();
  });

  it('uses the fallback provider on a server older than the capability', async () => {
    const http = {get: jest.fn(async () => ({status: 404, body: {}})), post: jest.fn(async () => ({status: 404, body: {}}))};
    (useAuth as jest.Mock).mockReturnValue({client: http, state: {status: 'signed-in', session: {token: 'token-a'}}});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'server-a', baseUrl: 'https://server-a.test'}});
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<AudioHost fallbackProvider={testProvider}><Probe /></AudioHost>);
    });
    expect(captured!.provider).toBe(testProvider);
    expect(captured!.library.path).toBe('/api/satellites/music');
    tree.unmount();
  });
});

describe('a queue restored at launch', () => {
  it('waits for the catalog to name the provider instead of failing', async () => {
    const http = {
      get: jest.fn(async (path: string) => ({status: 200, body: {track: {}, plan: null, stream: `stream/${path.split('/')[5]}`, gain: {db: 0}}})),
      post: jest.fn(async () => ({status: 200, body: {}})),
    };
    const library = new AudioLibraryClient(http as any);
    const effects = fakeEffects();
    const player = new PlayerController({
      api: library, baseUrl: 'https://server-a.test', token: () => 'token-a', deviceId: () => null, downloads: null,
      effects, network: effects.getNetworkType, preferences: () => preferences, saveLocal: jest.fn(),
    });
    const tracks = makeTracks(2);
    player.restore({tracks, order: [0, 1], position: 0, shuffle: false, repeat: 'off', seconds: 30, context: null});
    await Promise.resolve();
    expect(player.state.source).toBeNull();
    library.setProvider(testProvider);
    await act(async () => {
      await library.ready;
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });
    expect(player.state.error).toBeNull();
    expect(player.state.source?.uri).toContain('https://server-a.test/api/satellites/music/stream/');
    player.dispose();
  });
});
