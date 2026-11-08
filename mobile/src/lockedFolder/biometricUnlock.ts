import type {BiometricSigner, SecureStore} from '../platform/types';
import type {GrantRequest, LockedFolderApi} from './api';

/**
 * Optional biometric unlock for the Locked Folder - separate from, and
 * independent of, the app's own biometric app lock (src/auth/appLock.ts).
 *
 * The phone never stores the PIN. Turning this on (with the PIN) registers
 * the public half of a Keystore key that only signs after a fingerprint or
 * face match. Unlocking asks the server for a single-use challenge, signs it
 * behind the biometric prompt, and the server checks the signature - so a
 * client that merely *claims* a biometric match gets nothing. Anything
 * unexpected falls back to the PIN.
 *
 * Stored on the device, per server: the enrolled key's id (not a secret -
 * useless without the Keystore key). Per install: the key's public half,
 * so one key can serve several servers.
 */

const KEY_ID_PREFIX = 'starcore.lockedFolder.biometricKeyId';
const PUBLIC_KEY = 'starcore.lockedFolder.biometricPublicKey';

export type BiometricUnlockResult =
  /** the server unlocked this session */
  | 'unlocked'
  /** biometric unlock isn't set up for this server on this phone */
  | 'not-enrolled'
  /** no usable biometrics right now - use the PIN */
  | 'unavailable'
  /** the person dismissed the prompt */
  | 'cancelled'
  /** the enrollment no longer works (biometrics changed, PIN changed,
   * device removed) and was cleared - use the PIN, then turn it on again */
  | 'reenroll'
  /** the server refused the signature - use the PIN */
  | 'failed';

export interface BiometricDeps {
  api: LockedFolderApi;
  signer: BiometricSigner;
  store: SecureStore;
  serverId: string;
}

const keyIdKey = (serverId: string) => `${KEY_ID_PREFIX}.${serverId}`;

export async function isEnrolled({store, serverId}: Pick<BiometricDeps, 'store' | 'serverId'>): Promise<boolean> {
  return Boolean(await store.getItem(keyIdKey(serverId)));
}

/** Turns biometric unlock on for this server. Throws the server's error
 * for a wrong PIN or a lockout; resolves false when biometrics can't be
 * used on this phone. */
export async function enroll(deps: BiometricDeps, pin: string, deviceName: string): Promise<boolean> {
  const {api, signer, store, serverId} = deps;
  const availability = await signer.isAvailable();
  if (!availability.available) {
    return false;
  }

  let publicKey = (await signer.keyExists()) ? await store.getItem(PUBLIC_KEY) : null;
  if (!publicKey) {
    publicKey = await signer.createKey();
    if (!publicKey) {
      return false;
    }
    await store.setItem(PUBLIC_KEY, publicKey);
  }

  const previous = await store.getItem(keyIdKey(serverId));
  const keyId = await api.enrollBiometrics(pin, publicKey, deviceName);
  await store.setItem(keyIdKey(serverId), keyId);
  if (previous && previous !== keyId) {
    await api.revokeBiometrics(previous).catch(() => undefined);
  }
  return true;
}

/** Tries to unlock with biometrics. Throws only for a lockout (the error
 * carries `retryAfter`) or a network failure. */
export async function unlockWithBiometrics(deps: BiometricDeps, promptMessage: string): Promise<BiometricUnlockResult> {
  return (await signedUnlock(deps, promptMessage)).result;
}

/** Like unlockWithBiometrics, but asks for a single-use grant for `wanted` instead of an unlock:
 * the vault stays locked. `grant` is set when the result is 'unlocked'. */
export async function grantWithBiometrics(
  deps: BiometricDeps,
  promptMessage: string,
  wanted: GrantRequest,
): Promise<{result: BiometricUnlockResult; grant: string | null}> {
  return signedUnlock(deps, promptMessage, wanted);
}

async function signedUnlock(
  deps: BiometricDeps,
  promptMessage: string,
  wanted?: GrantRequest,
): Promise<{result: BiometricUnlockResult; grant: string | null}> {
  const done = (result: BiometricUnlockResult, grant: string | null = null) => ({result, grant});
  const {api, signer, store, serverId} = deps;
  const keyId = await store.getItem(keyIdKey(serverId));
  if (!keyId) {
    return done('not-enrolled');
  }
  if (!(await signer.isAvailable()).available) {
    return done('unavailable');
  }
  if (!(await signer.keyExists())) {
    await forget(deps, keyId);
    return done('reenroll');
  }

  const challenge = await api.biometricChallenge(keyId);
  if (challenge === null) {
    // the server dropped this device (PIN changed, or it was removed)
    await store.removeItem(keyIdKey(serverId));
    return done('reenroll');
  }

  const signed = await signer.sign(promptMessage, challenge);
  if (signed.status === 'cancelled') {
    return done('cancelled');
  }
  if (signed.status === 'key-invalid') {
    // usually new fingerprints/faces: Android invalidated the key on purpose
    await signer.deleteKey();
    await store.removeItem(PUBLIC_KEY);
    await forget(deps, keyId);
    return done('reenroll');
  }

  let grant: string | null;
  try {
    grant = wanted
      ? await api.biometricUnlock(keyId, challenge, signed.signature, wanted)
      : await api.biometricUnlock(keyId, challenge, signed.signature);
  } catch (error: any) {
    if (error?.status === 401) {
      return done('failed');
    }
    throw error;
  }
  if (wanted && !grant) {
    return done('failed'); // a server that unlocked instead of granting: never treated as a grant
  }
  return done('unlocked', grant);
}

/** Turns biometric unlock off for this server, on the phone and the server. */
export async function disable(deps: BiometricDeps): Promise<void> {
  const keyId = await deps.store.getItem(keyIdKey(deps.serverId));
  if (keyId) {
    await forget(deps, keyId);
  }
}

async function forget({api, store, serverId}: BiometricDeps, keyId: string): Promise<void> {
  await store.removeItem(keyIdKey(serverId));
  await api.revokeBiometrics(keyId).catch(() => undefined);
}
