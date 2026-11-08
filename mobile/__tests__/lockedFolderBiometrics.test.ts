import {LockedFolderError} from '../src/lockedFolder/api';
import type {LockedFolderApi} from '../src/lockedFolder/api';
import {LockedFolderApi as RealLockedFolderApi} from '../src/lockedFolder/api';
import {disable, enroll, grantWithBiometrics, isEnrolled, unlockWithBiometrics} from '../src/lockedFolder/biometricUnlock';
import type {BiometricSigner, SignResult} from '../src/platform/types';
import {FakeSecureStore} from './fakes';

class FakeSigner implements BiometricSigner {
  available = true;
  exists = false;
  publicKey: string | null = 'PUBLIC-KEY';
  signResult: SignResult = {status: 'signed', signature: 'SIGNED'};
  created = 0;
  deleted = 0;
  signed: string[] = [];

  async isAvailable() {
    return this.available
      ? {available: true, biometryType: 'fingerprint' as const}
      : {available: false, biometryType: 'none' as const, reason: 'not-enrolled' as const};
  }
  async keyExists() {
    return this.exists;
  }
  async createKey() {
    this.created += 1;
    this.exists = this.publicKey !== null;
    return this.publicKey;
  }
  async sign(_prompt: string, payload: string) {
    this.signed.push(payload);
    return this.signResult;
  }
  async deleteKey() {
    this.deleted += 1;
    this.exists = false;
  }
}

function fakeApi() {
  return {
    enrollBiometrics: jest.fn(async () => 'key-1'),
    biometricChallenge: jest.fn(async (): Promise<string | null> => 'CHALLENGE'),
    biometricUnlock: jest.fn(async () => undefined),
    revokeBiometrics: jest.fn(async () => undefined),
  };
}

function setup() {
  const api = fakeApi();
  const signer = new FakeSigner();
  const store = new FakeSecureStore();
  const deps = {api: api as unknown as LockedFolderApi, signer, store, serverId: 'srv-1'};
  return {api, signer, store, deps};
}

describe('Locked Folder biometric unlock', () => {
  it('enrolls with the PIN and remembers the key id for this server only', async () => {
    const {api, signer, deps} = setup();
    await expect(enroll(deps, '2468', 'Pixel')).resolves.toBe(true);
    expect(api.enrollBiometrics).toHaveBeenCalledWith('2468', 'PUBLIC-KEY', 'Pixel');
    expect(signer.created).toBe(1);
    expect(await isEnrolled(deps)).toBe(true);
    expect(await isEnrolled({...deps, serverId: 'srv-2'})).toBe(false);
  });

  it('never stores the PIN on the phone', async () => {
    const {store, deps} = setup();
    await enroll(deps, '86420', 'Pixel');
    for (const key of store.keys()) {
      expect(await store.getItem(key)).not.toContain('86420');
    }
  });

  it('reuses one Keystore key across servers', async () => {
    const {signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    await enroll({...deps, serverId: 'srv-2'}, '1357', 'Pixel');
    expect(signer.created).toBe(1);
  });

  it('does not enroll when the phone has no usable biometrics', async () => {
    const {api, signer, deps} = setup();
    signer.available = false;
    await expect(enroll(deps, '2468', 'Pixel')).resolves.toBe(false);
    expect(api.enrollBiometrics).not.toHaveBeenCalled();
    expect(await isEnrolled(deps)).toBe(false);
  });

  it('surfaces a wrong PIN from the server and stays unenrolled', async () => {
    const {api, deps} = setup();
    api.enrollBiometrics.mockRejectedValue(new LockedFolderError('incorrect PIN', 401));
    await expect(enroll(deps, '0000', 'Pixel')).rejects.toMatchObject({status: 401});
    expect(await isEnrolled(deps)).toBe(false);
  });

  it('unlocks by signing the server challenge, never on a local match alone', async () => {
    const {api, signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('unlocked');
    expect(signer.signed).toEqual(['CHALLENGE']);
    expect(api.biometricUnlock).toHaveBeenCalledWith('key-1', 'CHALLENGE', 'SIGNED');
  });

  it('falls back to the PIN when the server refuses the signature', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricUnlock.mockRejectedValue(new LockedFolderError('biometric unlock failed', 401));
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('failed');
  });

  it('reports a lockout instead of hiding it', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricUnlock.mockRejectedValue(new LockedFolderError('too many', 429, 120));
    await expect(unlockWithBiometrics(deps, 'Unlock')).rejects.toMatchObject({retryAfter: 120});
  });

  it('does nothing when the prompt is cancelled', async () => {
    const {api, signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    signer.signResult = {status: 'cancelled'};
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('cancelled');
    expect(api.biometricUnlock).not.toHaveBeenCalled();
    expect(await isEnrolled(deps)).toBe(true);
  });

  it('turns itself off when the enrolled biometrics change', async () => {
    const {api, signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    signer.signResult = {status: 'key-invalid'};
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('reenroll');
    expect(signer.deleted).toBe(1);
    expect(api.revokeBiometrics).toHaveBeenCalledWith('key-1');
    expect(await isEnrolled(deps)).toBe(false);
  });

  it('turns itself off when the server forgot this device (e.g. the PIN changed)', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricChallenge.mockResolvedValue(null);
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('reenroll');
    expect(await isEnrolled(deps)).toBe(false);
  });

  it('uses the PIN when biometrics are unavailable right now, keeping the enrollment', async () => {
    const {signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    signer.available = false;
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('unavailable');
    expect(await isEnrolled(deps)).toBe(true);
  });

  it('is not offered before enrolling', async () => {
    const {deps} = setup();
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('not-enrolled');
  });

  it('disabling revokes the key on the server too', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    await disable(deps);
    expect(api.revokeBiometrics).toHaveBeenCalledWith('key-1');
    expect(await isEnrolled(deps)).toBe(false);
  });

  describe('for a single-use grant (the secure action)', () => {
    const wanted = {operation: 'move_in', items: [{provider: 'Gallery', capability: 'media.gallery', id: 'p1'}]};

    it('signs the server challenge and hands back the grant, asking with `for`', async () => {
      const {api, signer, deps} = setup();
      await enroll(deps, '2468', 'Pixel');
      signer.exists = true;
      api.biometricUnlock.mockResolvedValueOnce('g-1' as any);
      await expect(grantWithBiometrics(deps, 'Move', wanted)).resolves.toEqual({result: 'unlocked', grant: 'g-1'});
      expect(api.biometricUnlock).toHaveBeenCalledWith('key-1', 'CHALLENGE', 'SIGNED', wanted);
    });

    it('never takes an answer without a grant as one', async () => {
      const {signer, deps} = setup();
      await enroll(deps, '2468', 'Pixel');
      signer.exists = true; // the fake server unlocks instead of granting: no grant comes back
      await expect(grantWithBiometrics(deps, 'Move', wanted)).resolves.toEqual({result: 'failed', grant: null});
    });

    it('asks the server for a grant with the PIN, never an unlock', async () => {
      const post = jest.fn(async () => ({status: 200, body: {unlocked: false, grant: 'g-2', expires_at: 'soon'}}));
      const api = new RealLockedFolderApi({post} as any);
      await expect(api.grant('2468', wanted)).resolves.toBe('g-2');
      expect(post).toHaveBeenCalledWith('/api/satellites/LockedFolder/unlock', {pin: '2468', for: wanted});
      post.mockResolvedValueOnce({status: 200, body: {unlocked: true, expires_at: 'later'}} as any);
      await expect(api.grant('2468', wanted)).rejects.toBeTruthy(); // an unlock is not a grant
      post.mockResolvedValueOnce({status: 401, body: {error: 'incorrect PIN'}} as any);
      await expect(api.grant('0000', wanted)).rejects.toMatchObject({status: 401});
    });
  });
});
