import {VaultApi, VaultError} from '../src/vault/api';
import {
  disable,
  enroll,
  grantWithBiometrics,
  isEnrolled,
  unlockWithBiometrics,
  type BiometricDeps,
  type EnrollingBiometricApi,
} from '../src/vault/biometricUnlock';
import type {BiometricSigner, SignResult} from '../src/platform/types';
import {FakeSecureStore} from './fakes';

// Biometric unlock of a media.vault store (src/vault/biometricUnlock.ts): the phone keeps no PIN,
// the server checks a signed single-use challenge, and what the signature buys - a full unlock or
// a grant for exactly some items - is decided when the challenge is asked for, never beside it.

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
    biometricChallenge: jest.fn<Promise<string | null>, unknown[]>(async () => 'CHALLENGE'),
    biometricUnlock: jest.fn<Promise<string | null>, unknown[]>(async () => null),
    revokeBiometrics: jest.fn(async () => undefined),
  };
}

function setup() {
  const api = fakeApi();
  const signer = new FakeSigner();
  const store = new FakeSecureStore();
  const deps: BiometricDeps<EnrollingBiometricApi> = {
    api: api as unknown as EnrollingBiometricApi,
    signer,
    store,
    serverId: 'srv-1',
    provider: 'Vault',
  };
  return {api, signer, store, deps};
}

describe('biometric unlock of a protected store', () => {
  it('enrolls with the PIN and remembers the key id for this server and provider only', async () => {
    const {api, signer, deps} = setup();
    await expect(enroll(deps, '2468', 'Pixel')).resolves.toBe(true);
    expect(api.enrollBiometrics).toHaveBeenCalledWith('2468', 'PUBLIC-KEY', 'Pixel');
    expect(signer.created).toBe(1);
    expect(await isEnrolled(deps)).toBe(true);
    expect(await isEnrolled({...deps, serverId: 'srv-2'})).toBe(false);
    expect(await isEnrolled({...deps, provider: 'Other'})).toBe(false);
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
    api.enrollBiometrics.mockRejectedValue(new VaultError('incorrect PIN', 401));
    await expect(enroll(deps, '0000', 'Pixel')).rejects.toMatchObject({status: 401});
    expect(await isEnrolled(deps)).toBe(false);
  });

  it('unlocks by signing a challenge asked for an unlock, never on a local match alone', async () => {
    const {api, signer, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('unlocked');
    expect(api.biometricChallenge).toHaveBeenCalledWith('key-1');
    expect(signer.signed).toEqual(['CHALLENGE']);
    expect(api.biometricUnlock).toHaveBeenCalledWith('key-1', 'CHALLENGE', 'SIGNED');
  });

  it('never takes a grant for an unlock', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricUnlock.mockResolvedValueOnce('g-0');
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('failed');
  });

  it('falls back to the PIN when the server refuses the signature', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricUnlock.mockRejectedValue(new VaultError('biometric unlock failed', 401));
    await expect(unlockWithBiometrics(deps, 'Unlock')).resolves.toBe('failed');
  });

  it('reports a lockout instead of hiding it', async () => {
    const {api, deps} = setup();
    await enroll(deps, '2468', 'Pixel');
    api.biometricUnlock.mockRejectedValue(new VaultError('too many', 429, 120));
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

    it('asks the challenge for the grant, then hands back what the signature bought', async () => {
      const {api, signer, deps} = setup();
      await enroll(deps, '2468', 'Pixel');
      signer.exists = true;
      api.biometricUnlock.mockResolvedValueOnce('g-1');
      await expect(grantWithBiometrics(deps, 'Move', wanted)).resolves.toEqual({result: 'unlocked', grant: 'g-1'});
      expect(api.biometricChallenge).toHaveBeenCalledWith('key-1', wanted);
      // the purpose is the server's, kept with the challenge: nothing beside the signature
      expect(api.biometricUnlock).toHaveBeenCalledWith('key-1', 'CHALLENGE', 'SIGNED');
    });

    it('never takes an answer without a grant as one', async () => {
      const {signer, deps} = setup();
      await enroll(deps, '2468', 'Pixel');
      signer.exists = true; // the fake server unlocks instead of granting: no grant comes back
      await expect(grantWithBiometrics(deps, 'Move', wanted)).resolves.toEqual({result: 'failed', grant: null});
    });
  });
});

type Answer = {status: number; body: any};

describe('a media.vault provider’s routes', () => {
  const PROVIDER = {
    satellite: 'Vault',
    version: 1,
    enabled: true,
    operations: {status: 'status', unlock: 'unlock', lock: 'lock', keep: 'keep', biometric: 'biometric'},
  };
  const wanted = {operation: 'move_in', items: [{provider: 'Gallery', capability: 'media.gallery', id: 'p1'}]};

  it('asks for a grant with the PIN, never takes an unlock for one', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {unlocked: false, grant: 'g-2', expires_at: 'soon'}}));
    const api = new VaultApi({post} as any, PROVIDER);
    await expect(api.grant('2468', wanted)).resolves.toBe('g-2');
    expect(post).toHaveBeenCalledWith('/api/satellites/Vault/unlock', {pin: '2468', for: wanted});
    post.mockResolvedValueOnce({status: 200, body: {unlocked: true, expires_at: 'later'}} as any);
    await expect(api.grant('2468', wanted)).rejects.toBeTruthy(); // an unlock is not a grant
    post.mockResolvedValueOnce({status: 401, body: {error: 'incorrect PIN'}} as any);
    await expect(api.grant('0000', wanted)).rejects.toMatchObject({status: 401});
  });

  it('unlocks only when the store says it opened', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {unlocked: true}}));
    const api = new VaultApi({post} as any, PROVIDER);
    await expect(api.unlock('2468')).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith('/api/satellites/Vault/unlock', {pin: '2468'});
    post.mockResolvedValueOnce({status: 200, body: {unlocked: false, grant: 'g'}} as any);
    await expect(api.unlock('2468')).rejects.toBeTruthy();
    post.mockResolvedValueOnce({status: 429, body: {error: 'wait', retry_after: 30}} as any);
    await expect(api.unlock('2468')).rejects.toMatchObject({status: 429, retryAfter: 30});
  });

  it('sends the purpose with the challenge and nothing but the signature after it', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {challenge: 'C'}}));
    const api = new VaultApi({post} as any, PROVIDER);
    await expect(api.biometricChallenge('key-1', wanted)).resolves.toBe('C');
    expect(post).toHaveBeenLastCalledWith('/api/satellites/Vault/biometric/challenge', {key_id: 'key-1', for: wanted});
    await api.biometricChallenge('key-1');
    expect(post).toHaveBeenLastCalledWith('/api/satellites/Vault/biometric/challenge', {key_id: 'key-1'});
    post.mockResolvedValueOnce({status: 200, body: {grant: 'g-3'}} as any);
    await expect(api.biometricUnlock('key-1', 'C', 'S')).resolves.toBe('g-3');
    expect(post).toHaveBeenLastCalledWith('/api/satellites/Vault/biometric/unlock', {key_id: 'key-1', challenge: 'C', signature: 'S'});
    post.mockResolvedValueOnce({status: 404, body: {}} as any);
    await expect(api.biometricChallenge('key-1')).resolves.toBeNull();
  });

  it('turns biometric unlock on with the PIN, through the biometric operation', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {key_id: 'key-9'}}));
    const api = new VaultApi({post} as any, PROVIDER);
    await expect(api.enrollBiometrics('2468', 'PUB', 'Phone')).resolves.toBe('key-9');
    expect(post).toHaveBeenCalledWith('/api/satellites/Vault/biometric/enroll', {pin: '2468', public_key: 'PUB', device_name: 'Phone'});
    post.mockResolvedValueOnce({status: 401, body: {error: 'incorrect PIN'}} as any);
    await expect(api.enrollBiometrics('0000', 'PUB', 'Phone')).rejects.toMatchObject({status: 401});
  });

  it('keeps an unlock alive, and says so when the store is locked again', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {expires_at: 'later'}}));
    const api = new VaultApi({post} as any, PROVIDER);
    await expect(api.keep()).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith('/api/satellites/Vault/keep', {});
    post.mockResolvedValueOnce({status: 403, body: {error: 'locked'}} as any);
    await expect(api.keep()).rejects.toMatchObject({status: 403});
  });

  it('calls only the operations the catalog names, and only safe ones', async () => {
    const post = jest.fn<Promise<Answer>, unknown[]>(async () => ({status: 200, body: {}}));
    const bare = new VaultApi({post} as any, {...PROVIDER, operations: {status: 'status', unlock: 'unlock', lock: 'lock'}});
    expect(bare.biometrics).toBe(false);
    await expect(bare.keep()).rejects.toBeTruthy();
    const unsafe = new VaultApi({post} as any, {...PROVIDER, operations: {...PROVIDER.operations, lock: '../lock'}});
    await expect(unsafe.lock()).rejects.toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
