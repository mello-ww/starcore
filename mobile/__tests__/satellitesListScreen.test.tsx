import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {SatellitesListScreen} from '../src/screens/SatellitesListScreen';

// Factory-mocked (not auto-mocked) so requiring this module never pulls in
// its real platform/biometrics or platform/secureStorage imports, which
// Jest (unlike Metro) can't resolve for a bare, unsuffixed import - see
// src/platform/README.md.
jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));
jest.mock('../src/satellites/cache');
jest.mock('../src/satellites/api', () => {
  const list = jest.fn();
  return {SatellitesApi: jest.fn().mockImplementation(() => ({list})), __mocks: {list}};
});

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';
import {getCachedSatellites, setCachedSatellites} from '../src/satellites/cache';
const {__mocks} = jest.requireMock('../src/satellites/api') as {__mocks: {list: jest.Mock}};

const navigation = {navigate: jest.fn()} as any;
const route = {} as any;

const satelliteA = {
  name: 'status', version: '1', author: 'a', description: 'System status', icon: null,
  type: 'native' as const, enabled: true, status: 'running' as const, configurable: false, mobile_ui: true,
};
const satelliteB = {
  name: 'docker', version: '1', author: 'a', description: 'Container control', icon: null,
  type: 'link' as const, enabled: true, status: 'stopped' as const, configurable: true, mobile_ui: false,
};

/**
 * Covers requirement 2 (satellite system): the Satellites tab fetches from
 * the currently active server's /api/satellites, shows loading/cached/error
 * states, and lets satellites without a mobile UI be seen but not opened.
 */
describe('SatellitesListScreen', () => {
  beforeEach(() => {
    __mocks.list.mockReset();
    (getCachedSatellites as jest.Mock).mockReset().mockResolvedValue(null);
    (setCachedSatellites as jest.Mock).mockReset().mockResolvedValue(undefined);
    (useAuth as jest.Mock).mockReturnValue({client: {}});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 'srv-1', name: 'Home'}});
    navigation.navigate.mockReset();
  });

  function texts(tree: ReturnType<typeof renderer.create>) {
    return tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
  }

  it('renders the satellites the active server reports', async () => {
    __mocks.list.mockResolvedValue([satelliteA, satelliteB]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['status', 'docker']));
    expect(setCachedSatellites).toHaveBeenCalledWith('srv-1', [satelliteA, satelliteB]);
  });

  it('does not list a satellite that lives inside another (the Locked Folder, in Photos)', async () => {
    const lockedFolder = {...satelliteB, name: 'LockedFolder', section_of: 'Photo'};
    __mocks.list.mockResolvedValue([satelliteA, lockedFolder]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toContain('status');
    expect(texts(tree)).not.toContain('LockedFolder');
  });

  it('marks a satellite with no mobile UI as such and does not navigate on tap', async () => {
    __mocks.list.mockResolvedValue([satelliteB]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['No mobile interface yet']));
    const pressable = tree.root.findByProps({disabled: true});
    expect(pressable).toBeTruthy();
  });

  it('navigates to the satellite detail screen when one with a mobile UI is tapped', async () => {
    __mocks.list.mockResolvedValue([satelliteA]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    act(() => tree.root.findByProps({disabled: false}).props.onPress());

    expect(navigation.navigate).toHaveBeenCalledWith('SatelliteDetail', {name: 'status'});
  });

  it('shows an error when the server cannot be reached and nothing is cached', async () => {
    __mocks.list.mockRejectedValue(new Error('Could not reach StarCore.'));
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['Could not reach StarCore.']));
  });

  it('falls back to the cached list, marked as such, when the server is unreachable', async () => {
    (getCachedSatellites as jest.Mock).mockResolvedValue([satelliteA]);
    __mocks.list.mockRejectedValue(new Error('network error'));
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['status', 'Showing cached data - offline']));
  });

  it('opens the dedicated Photo screens instead of the generic satellite detail screen', async () => {
    const photoSatellite = {...satelliteA, name: 'Photo', description: 'Photo library'};
    __mocks.list.mockResolvedValue([photoSatellite]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    act(() => tree.root.findByProps({disabled: false}).props.onPress());

    expect(navigation.navigate).toHaveBeenCalledWith('PhotoHome');
    expect(navigation.navigate).not.toHaveBeenCalledWith('SatelliteDetail', expect.anything());
  });

  it('opens the native Status screen for the Status satellite', async () => {
    __mocks.list.mockResolvedValue([{...satelliteA, name: 'Status', description: 'System monitoring satellite.'}]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    act(() => tree.root.findByProps({disabled: false}).props.onPress());

    expect(navigation.navigate).toHaveBeenCalledWith('StatusHome');
  });

  it('shows an empty state when the server reports no satellites', async () => {
    __mocks.list.mockResolvedValue([]);
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['No Satellites are loaded on this server.']));
  });

  it('reads and writes the cache under the active server\'s own id', async () => {
    __mocks.list.mockResolvedValue([satelliteA]);
    await act(async () => {
      renderer.create(<SatellitesListScreen navigation={navigation} route={route} />);
    });

    expect(getCachedSatellites).toHaveBeenCalledWith('srv-1');
    expect(setCachedSatellites).toHaveBeenCalledWith('srv-1', [satelliteA]);
  });
});
