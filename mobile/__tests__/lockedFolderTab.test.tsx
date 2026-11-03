import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AppState, Text, TextInput} from 'react-native';

// the hook pulls in platform/biometrics, which Jest can't resolve unsuffixed
// (see src/platform/README.md) - so it's replaced with a fake API here
jest.mock('../src/lockedFolder/useLockedFolder', () => ({useLockedFolder: jest.fn()}));
jest.mock('../src/platform/privacy', () => ({privacy: {setSecure: jest.fn(), evictImages: jest.fn()}}));
jest.mock('../src/lockedFolder/PrivateImage', () => {
  const {View} = require('react-native');
  return {PrivateImage: (props: any) => <View testID="private-image" {...props} />};
});

import {useLockedFolder} from '../src/lockedFolder/useLockedFolder';
import {privacy} from '../src/platform/privacy';
import {LockedFolderTab} from '../src/photo/LockedFolderTab';
import {FakeSecureStore} from './fakes';

const baseStatus = {
  configured: true,
  path: '/vault',
  path_exists: true,
  pin_set: true,
  unlocked: false,
  expires_at: null,
  session_timeout_seconds: 900,
};

const items = [
  {path: 'Photos/a.png', name: 'a.png', size: 10, modified: '2026-11-01T00:00:00+00:00', media_type: 'photo', content_type: 'image/png'},
  {path: 'notes.txt', name: 'notes.txt', size: 3, modified: '2026-11-01T00:00:00+00:00', media_type: 'file', content_type: 'text/plain'},
];

function fakeApi(status: object | null) {
  return {
    status: jest.fn(async () => status),
    media: jest.fn(async () => items),
    unlock: jest.fn(async () => undefined),
    lock: jest.fn(async () => undefined),
    setPin: jest.fn(async () => undefined),
    moveOut: jest.fn(async () => ({moved: [{path: 'Photos/a.png', id: 'x'}], failed: []})),
    filePath: (path: string) => `/api/satellites/LockedFolder/media/file?path=${path}`,
  };
}

function useApi(api: ReturnType<typeof fakeApi>) {
  const signer = {
    isAvailable: async () => ({available: false, biometryType: 'none' as const}),
    keyExists: async () => false,
    createKey: async () => null,
    sign: async () => ({status: 'cancelled' as const}),
    deleteKey: async () => undefined,
  };
  (useLockedFolder as jest.Mock).mockReturnValue({
    api,
    serverId: 'srv-1',
    baseUrl: 'http://star',
    token: 'token',
    biometricDeps: {api, signer, store: new FakeSecureStore(), serverId: 'srv-1'},
  });
}

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root
    .findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat(3)
    .filter((value: unknown) => typeof value === 'string');
}

const mounted: Tree[] = [];

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(<LockedFolderTab />);
  });
  mounted.push(tree);
  return tree;
}

// stops timers (the lockout countdown, the relock timer) with each test
afterEach(async () => {
  for (const tree of mounted.splice(0)) {
    await act(async () => tree.unmount());
  }
});

describe('LockedFolderTab', () => {
  let appStateListener: ((state: string) => void) | null;

  beforeEach(() => {
    (privacy.setSecure as jest.Mock).mockClear();
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, listener: any) => {
      appStateListener = listener;
      return {remove: jest.fn()};
    }) as any);
  });

  it('asks for the PIN while locked and never loads the vault', async () => {
    const api = fakeApi(baseStatus);
    useApi(api);
    const tree = await render();
    expect(texts(tree)).toContain('Locked Folder is locked');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    expect(api.media).not.toHaveBeenCalled();
  });

  it('says when an existing PIN was set and how a forgotten one is recovered', async () => {
    // a PIN set months ago on a vault the user believes is new: unlock, never setup
    const api = fakeApi({...baseStatus, pin_set_at: '2026-09-05T11:23:10+00:00', encryption: {state: 'off', recovery_key: false}});
    useApi(api);
    const tree = await render();
    const intro = texts(tree).find(text => text.startsWith('Enter the PIN set for this Locked Folder on'));
    expect(intro).toBeDefined();
    expect(intro).toMatch(/2026/);
    expect(api.setPin).not.toHaveBeenCalled();

    const forgot = tree.root.findAll((node: any) => node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).some((text: any) => text.props.children === 'Forgot your PIN?'))[0];
    await act(async () => forgot.props.onPress());
    expect(texts(tree).some(text => text.includes('delete pin.json') && text.includes('not touched'))).toBe(true);
  });

  it('keeps the screen secure while it is open', async () => {
    useApi(fakeApi(baseStatus));
    const tree = await render();
    expect(privacy.setSecure).toHaveBeenLastCalledWith(true);
    await act(async () => mounted.splice(mounted.indexOf(tree), 1)[0].unmount());
    expect(privacy.setSecure).toHaveBeenLastCalledWith(false);
  });

  it('unlocks with the PIN through the server', async () => {
    const api = fakeApi(baseStatus);
    useApi(api);
    const tree = await render();
    api.status.mockResolvedValue({...baseStatus, unlocked: true, expires_at: '2099-01-01T00:00:00+00:00'});
    const input = tree.root.findByType(TextInput);
    await act(async () => input.props.onChangeText('2468'));
    await act(async () => tree.root.findByProps({title: 'Unlock'}).props.onPress());
    expect(api.unlock).toHaveBeenCalledWith('2468');
    expect(api.media).toHaveBeenCalled();
    expect(tree.root.findAllByProps({testID: 'private-image'}).length).toBeGreaterThan(0);
    expect(texts(tree)).toContain('notes.txt');
  });

  it('shows the lockout wait instead of the PIN result', async () => {
    const api = fakeApi(baseStatus);
    api.unlock.mockRejectedValue(Object.assign(new Error('too many'), {status: 429, retryAfter: 120}));
    useApi(api);
    const tree = await render();
    await act(async () => tree.root.findByType(TextInput).props.onChangeText('0000'));
    await act(async () => tree.root.findByProps({title: 'Unlock'}).props.onPress());
    expect(texts(tree).join(' ')).toContain('Try again in');
  });

  it('locks again when the app goes to the background', async () => {
    const api = fakeApi({...baseStatus, unlocked: true, expires_at: '2099-01-01T00:00:00+00:00'});
    useApi(api);
    const tree = await render();
    expect(tree.root.findAllByProps({testID: 'private-image'}).length).toBeGreaterThan(0);

    await act(async () => appStateListener?.('background'));
    expect(api.lock).toHaveBeenCalled();
    expect(tree.root.findAllByProps({testID: 'private-image'})).toHaveLength(0);
    expect(texts(tree)).toContain('Locked Folder is locked');
  });

  it('locks again when the section closes', async () => {
    const api = fakeApi({...baseStatus, unlocked: true, expires_at: '2099-01-01T00:00:00+00:00'});
    useApi(api);
    const tree = await render();
    await act(async () => mounted.splice(mounted.indexOf(tree), 1)[0].unmount());
    expect(api.lock).toHaveBeenCalled();
  });

  it('explains where to set it up when the server has none configured', async () => {
    useApi(fakeApi({...baseStatus, configured: false, pin_set: false}));
    const tree = await render();
    expect(texts(tree)).toContain('Set up your Locked Folder');
  });

  it('keeps the vault locked when the stored PIN is unreadable', async () => {
    const api = fakeApi({...baseStatus, pin_unreadable: true});
    useApi(api);
    const tree = await render();
    expect(texts(tree)).toContain('The PIN can’t be read');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('stays locked, with no PIN entry, when the server reports a security problem', async () => {
    const api = fakeApi({
      ...baseStatus,
      security: {problem: 'pin_tampered'},
      encryption: {available: true, state: 'on', problem: null, recovery_key: true},
    });
    useApi(api);
    const tree = await render();
    expect(texts(tree)).toContain('The PIN was changed outside StarCore');
    expect(texts(tree).join(' ')).toContain('recovery key in Mission Control');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(api.media).not.toHaveBeenCalled();
  });

  it('says so when this server cannot open the vault and there is no recovery key', async () => {
    useApi(fakeApi({
      ...baseStatus,
      security: {problem: 'key_unavailable'},
      encryption: {available: true, state: 'on', problem: 'key_unavailable', recovery_key: false},
    }));
    const tree = await render();
    expect(texts(tree)).toContain('This server can’t open the Locked Folder');
    expect(texts(tree).join(' ')).toContain('no recovery key was set up');
  });

  it('lists a damaged encrypted file without opening it', async () => {
    const api = fakeApi({...baseStatus, unlocked: true, expires_at: '2099-01-01T00:00:00+00:00',
      encryption: {available: true, state: 'on', problem: null, recovery_key: false}});
    api.media.mockResolvedValue([
      {path: '.starcore-vault/objects/ab.sclf', name: 'Damaged file', size: 99, modified: null,
        media_type: 'file', content_type: 'application/octet-stream', encrypted: true, damaged: true},
    ] as any);
    useApi(api);
    const tree = await render();
    expect(texts(tree)).toContain('Damaged file');
    expect(texts(tree)).toContain('· encrypted');
    expect(tree.root.findAllByProps({testID: 'private-image'})).toHaveLength(0);
  });
});
