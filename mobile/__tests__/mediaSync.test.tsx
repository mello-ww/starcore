import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {PermissionsAndroid, Switch, Text} from 'react-native';
import type {SyncNative, SyncState} from '../src/sync/native';
import {failureReason, isPlainHttp, syncLine, timeAgo} from '../src/sync/state';
import {requestMediaAccess} from '../src/sync/permissions';
import {forgetSync, setUpSync, SyncSetupError} from '../src/sync/setup';

// The app's background backup of the phone's media (client capability device.media-sync): its
// state line, the permission flow, setup and forgetting, and the sync screen over a fake of the
// Kotlin sync module.

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));
let mockNative: SyncNative | null = null;
jest.mock('../src/sync/native', () => ({nativeSync: () => mockNative}));

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';
import {MediaSyncScreen} from '../src/sync/MediaSyncScreen';

const PROVIDER = {
  satellite: 'Gallery',
  version: 1,
  enabled: true,
  operations: {status: 'backup/status', check: 'backup/check', upload: 'backup/upload', devices: 'backup/devices'},
};

const NOT_SET_UP: SyncState = {configured: false, access: 'full', network: 'unmetered', plugged: false, batteryLow: false};
const SET_UP: SyncState = {
  configured: true,
  access: 'full',
  network: 'unmetered',
  plugged: false,
  batteryLow: false,
  enabled: true,
  mobileData: false,
  charging: false,
  excluded: [],
  origin: 'https://home.example',
  credential: true,
  phase: 'idle',
  done: 0,
  total: 0,
  lastRun: 0,
  running: false,
  waiting: false,
  backedUp: 0,
  pending: 0,
  failed: 0,
};

function fakeNative(state: SyncState, overrides: Partial<SyncNative> = {}): SyncNative {
  return {
    deviceName: 'Pixel 8',
    sdk: 34,
    configure: jest.fn().mockResolvedValue({...SET_UP}),
    update: jest.fn().mockResolvedValue(state),
    state: jest.fn().mockResolvedValue(state),
    folders: jest.fn().mockResolvedValue([
      {id: '1', name: 'Camera', path: 'DCIM/Camera/', count: 3},
      {id: '2', name: 'Screenshots', path: 'Pictures/Screenshots/', count: 1},
    ]),
    failures: jest.fn().mockResolvedValue([]),
    retry: jest.fn().mockResolvedValue(state),
    runNow: jest.fn().mockResolvedValue(state),
    forget: jest.fn().mockResolvedValue('session-1'),
    ...overrides,
  };
}

describe('the state line', () => {
  const NOW = 1_700_000_000_000;

  it('says the most pressing thing first', () => {
    expect(syncLine(NOT_SET_UP, NOW)).toEqual({text: 'Not set up on this phone', tone: 'normal'});
    expect(syncLine({...SET_UP, enabled: false}, NOW).text).toBe('Off');
    expect(syncLine({...SET_UP, access: 'partial'}, NOW)).toEqual({text: 'Permission needed', tone: 'attention'});
    expect(syncLine({...SET_UP, credential: false}, NOW).text).toBe('Sign in again');
    expect(syncLine({...SET_UP, phase: 'signed-out'}, NOW).text).toBe('Sign in again');
    expect(syncLine({...SET_UP, phase: 'server-full'}, NOW).tone).toBe('attention');
    expect(syncLine({...SET_UP, phase: 'unavailable'}, NOW).tone).toBe('attention');
  });

  it('counts what a run sends', () => {
    expect(syncLine({...SET_UP, running: true, phase: 'uploading', done: 2, total: 5}, NOW).text).toBe('Backing up 3 of 5');
    expect(syncLine({...SET_UP, running: true, phase: 'uploading', done: 5, total: 5}, NOW).text).toBe('Backing up 5 of 5');
    expect(syncLine({...SET_UP, running: true, phase: 'scanning'}, NOW).text).toBe('Looking for new photos and videos');
  });

  it('says what a waiting run waits for', () => {
    const waiting = {...SET_UP, waiting: true};
    expect(syncLine({...waiting, network: 'none'}, NOW).text).toBe('Waiting for a network');
    expect(syncLine({...waiting, network: 'metered'}, NOW).text).toBe('Waiting for Wi-Fi');
    expect(syncLine({...waiting, network: 'metered', mobileData: true}, NOW).text).toBe('Starting soon');
    expect(syncLine({...waiting, charging: true}, NOW).text).toBe('Waiting for the charger');
    expect(syncLine({...waiting, batteryLow: true}, NOW).text).toBe('Waiting for the battery to charge');
    expect(syncLine({...waiting, phase: 'offline'}, NOW).text).toBe('Waiting for the server');
  });

  it('says where it stands between runs', () => {
    expect(syncLine({...SET_UP, phase: 'offline'}, NOW).text).toBe("Couldn't reach the server, it will try again");
    expect(syncLine({...SET_UP, pending: 4}, NOW).text).toBe('4 to back up');
    expect(syncLine({...SET_UP, lastRun: NOW - 5 * 60_000}, NOW).text).toBe('Up to date, 5 min ago');
    expect(syncLine(SET_UP, NOW).text).toBe('Not backed up yet');
  });

  it('words times, reasons and plain HTTP', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago');
    expect(failureReason('too-large')).toBe('Larger than the server takes');
    expect(failureReason('anything else')).toBe('The server refused it');
    expect(isPlainHttp('http://192.168.1.2:8090')).toBe(true);
    expect(isPlainHttp('https://home.example')).toBe(false);
    expect(isPlainHttp(undefined)).toBe(false);
  });
});

describe('asking for media access', () => {
  afterEach(() => jest.restoreAllMocks());

  function answers(results: Record<string, string>) {
    return jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(results as any);
  }

  it('asks for images and videos, then the optional ones (Android 14)', async () => {
    const request = answers({
      'android.permission.READ_MEDIA_IMAGES': 'granted',
      'android.permission.READ_MEDIA_VIDEO': 'granted',
    });
    expect(await requestMediaAccess(34)).toBe('full');
    expect(request.mock.calls[0][0]).toEqual([
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
    ]);
    expect(request.mock.calls[1][0]).toEqual(['android.permission.ACCESS_MEDIA_LOCATION', 'android.permission.POST_NOTIFICATIONS']);
  });

  it('tells selected photos only, a refusal and a blocked dialog apart', async () => {
    answers({'android.permission.READ_MEDIA_VISUAL_USER_SELECTED': 'granted', 'android.permission.READ_MEDIA_IMAGES': 'denied'});
    expect(await requestMediaAccess(34)).toBe('partial');
    answers({'android.permission.READ_MEDIA_IMAGES': 'denied', 'android.permission.READ_MEDIA_VIDEO': 'denied'});
    expect(await requestMediaAccess(33)).toBe('denied');
    answers({'android.permission.READ_MEDIA_IMAGES': 'never_ask_again', 'android.permission.READ_MEDIA_VIDEO': 'denied'});
    expect(await requestMediaAccess(33)).toBe('blocked');
  });

  it('asks for storage before Android 13', async () => {
    const request = answers({'android.permission.READ_EXTERNAL_STORAGE': 'granted'});
    expect(await requestMediaAccess(30)).toBe('full');
    expect(request.mock.calls[0][0]).toEqual(['android.permission.READ_EXTERNAL_STORAGE']);
    expect(request.mock.calls[1][0]).toEqual(['android.permission.ACCESS_MEDIA_LOCATION']);
  });
});

describe('setting up and forgetting', () => {
  it('asks for a device credential limited to the capability, and hands everything to the sync module', async () => {
    const native = fakeNative(NOT_SET_UP);
    const client = {post: jest.fn().mockResolvedValue({status: 200, body: {token: 't0k', session_id: 'session-1'}})} as any;
    await setUpSync({client, native, serverId: 's1', origin: 'https://home.example', capability: 'media.sync', provider: PROVIDER});
    expect(client.post).toHaveBeenCalledWith('/api/auth/devices', {capability: 'media.sync', device_name: 'Pixel 8'});
    expect(native.configure).toHaveBeenCalledWith('s1', {
      origin: 'https://home.example',
      satellite: 'Gallery',
      routes: {status: 'backup/status', check: 'backup/check', upload: 'backup/upload'},
      device: 'Pixel 8',
      token: 't0k',
      sessionId: 'session-1',
    });
  });

  it('stops with words when the server says no', async () => {
    const native = fakeNative(NOT_SET_UP);
    const full = {post: jest.fn().mockResolvedValue({status: 409, body: {}})} as any;
    const args = {native, serverId: 's1', origin: 'https://home.example', capability: 'media.sync', provider: PROVIDER};
    await expect(setUpSync({...args, client: full})).rejects.toThrow(/as many devices/);
    const refused = {post: jest.fn().mockResolvedValue({status: 404, body: {error: 'No provider'}})} as any;
    await expect(setUpSync({...args, client: refused})).rejects.toThrow('No provider');
    const missing = {...PROVIDER, operations: {status: 'backup/status'}};
    await expect(setUpSync({...args, client: full, provider: missing})).rejects.toBeInstanceOf(SyncSetupError);
    expect(native.configure).not.toHaveBeenCalled();
  });

  it('revokes the credential on signing out, and never throws', async () => {
    const native = fakeNative(SET_UP);
    const client = {post: jest.fn().mockResolvedValue({status: 200, body: {}})} as any;
    await forgetSync(native, 's1', client);
    expect(native.forget).toHaveBeenCalledWith('s1');
    expect(client.post).toHaveBeenCalledWith('/api/auth/sessions/revoke', {session_id: 'session-1'});

    const unreachable = {post: jest.fn().mockRejectedValue(new Error('offline'))} as any;
    await expect(forgetSync(native, 's1', unreachable)).resolves.toBeUndefined();
    await expect(forgetSync(null, 's1', client)).resolves.toBeUndefined();
  });
});

describe('the sync screen', () => {
  let tree: ReturnType<typeof renderer.create> | null = null;

  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    mockNative = null;
    jest.restoreAllMocks();
  });

  async function open(native: SyncNative | null, providers: any[] = [PROVIDER], params: any = {capability: 'media.sync'}) {
    mockNative = native;
    const client = {
      get: jest.fn().mockResolvedValue({status: 200, body: {capabilities: {'media.sync': providers}}}),
      post: jest.fn().mockResolvedValue({status: 200, body: {token: 't0k', session_id: 'session-1'}}),
    };
    (useAuth as jest.Mock).mockReturnValue({client});
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 's1', name: 'Home', baseUrl: 'https://home.example'}});
    await act(async () => {
      tree = renderer.create(<MediaSyncScreen route={{params}} />);
    });
    await act(async () => {});
    return client;
  }

  // the outermost element with the testID (a Button hands its own down to what it renders)
  const byId = (id: string) =>
    tree!.root.findAll(
      (node: any) => node.props.testID === id && typeof node.type !== 'string' && node.parent?.props?.testID !== id,
    );
  const switchOf = (id: string) => tree!.root.findAll((node: any) => node.type === Switch && node.props.testID === id)[0];
  const text = () =>
    tree!.root
      .findAllByType(Text)
      .map((node: any) => [].concat(node.props.children).join(''))
      .join(' | ');

  it('says when this phone has no background backup', async () => {
    await open(null);
    expect(text()).toContain("This phone can't back up from this app.");
  });

  it('says when the server takes no backups', async () => {
    await open(fakeNative(NOT_SET_UP), []);
    expect(byId('sync-no-provider')).toHaveLength(1);
    expect(switchOf('sync-enabled')).toBeUndefined();
  });

  it('sets the backup up when it is turned on', async () => {
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      'android.permission.READ_MEDIA_IMAGES': 'granted',
      'android.permission.READ_MEDIA_VIDEO': 'granted',
    } as any);
    const native = fakeNative({...NOT_SET_UP, access: 'none'});
    const client = await open(native);
    expect(text()).toContain('Not set up on this phone');
    expect(switchOf('sync-mobile-data')).toBeUndefined();

    await act(async () => {
      await switchOf('sync-enabled').props.onValueChange(true);
    });
    expect(client.post).toHaveBeenCalledWith('/api/auth/devices', {capability: 'media.sync', device_name: 'Pixel 8'});
    expect(native.configure).toHaveBeenCalledWith('s1', expect.objectContaining({satellite: 'Gallery', token: 't0k'}));
  });

  it('goes no further when only some photos are allowed', async () => {
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED': 'granted',
    } as any);
    const native = fakeNative({...NOT_SET_UP, access: 'partial'});
    const client = await open(native);
    await act(async () => {
      await switchOf('sync-enabled').props.onValueChange(true);
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(byId('sync-notice')).toHaveLength(1);
    expect(byId('sync-open-settings')).toHaveLength(1);
  });

  it('forgets what it asked once all photos are allowed in the system settings', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED': 'granted',
      } as any);
      const native = fakeNative({...NOT_SET_UP, access: 'partial'});
      await open(native);
      await act(async () => {
        await switchOf('sync-enabled').props.onValueChange(true);
      });
      expect(byId('sync-open-settings')).toHaveLength(1);

      (native.state as jest.Mock).mockResolvedValue({...NOT_SET_UP, access: 'full'});
      await act(async () => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {});
      expect(byId('sync-open-settings')).toHaveLength(0);
      expect(byId('sync-notice')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('changes when and what it backs up', async () => {
    const native = fakeNative({...SET_UP, excluded: ['2']});
    await open(native);
    expect(switchOf('sync-enabled').props.value).toBe(true);
    expect(switchOf('sync-folder-1').props.value).toBe(true);
    expect(switchOf('sync-folder-2').props.value).toBe(false);

    await act(async () => {
      await switchOf('sync-mobile-data').props.onValueChange(true);
    });
    expect(native.update).toHaveBeenLastCalledWith('s1', {mobileData: true});
    await act(async () => {
      await switchOf('sync-charging').props.onValueChange(true);
    });
    expect(native.update).toHaveBeenLastCalledWith('s1', {charging: true});
    await act(async () => {
      await switchOf('sync-folder-1').props.onValueChange(false);
    });
    expect(native.update).toHaveBeenLastCalledWith('s1', {excluded: ['1', '2']});
    await act(async () => {
      await switchOf('sync-folder-2').props.onValueChange(true);
    });
    expect(native.update).toHaveBeenLastCalledWith('s1', {excluded: []});
    await act(async () => {
      await switchOf('sync-enabled').props.onValueChange(false);
    });
    expect(native.update).toHaveBeenLastCalledWith('s1', {enabled: false});

    await act(async () => {
      await byId('sync-now')[0].props.onPress();
    });
    expect(native.runNow).toHaveBeenCalledWith('s1');
  });

  it('lists what was not backed up, and tries again', async () => {
    const native = fakeNative(
      {...SET_UP, failed: 3},
      {failures: jest.fn().mockResolvedValue([{id: '9', name: 'huge.mp4', folder: 'DCIM/Camera/', reason: 'too-large'}])},
    );
    await open(native);
    expect(byId('sync-failure')).toHaveLength(1);
    expect(text()).toContain('Larger than the server takes');
    expect(text()).toContain('and 2 more');
    await act(async () => {
      await byId('sync-retry')[0].props.onPress();
    });
    expect(native.retry).toHaveBeenCalledWith('s1');
  });

  it('asks to sign in again when the credential is gone, and warns about plain HTTP', async () => {
    await open(fakeNative({...SET_UP, credential: false, origin: 'http://192.168.1.2:8090'}));
    expect(byId('sync-sign-in')).toHaveLength(1);
    expect(byId('sync-now')).toHaveLength(0);
    expect(byId('sync-http')).toHaveLength(1);
  });
});
