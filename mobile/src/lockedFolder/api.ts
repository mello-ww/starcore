import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';

const BASE = '/api/satellites/LockedFolder';

export interface LockedFolderStatus {
  configured: boolean;
  path: string | null;
  path_exists: boolean | null;
  pin_set: boolean;
  pin_unreadable?: boolean;
  unlocked: boolean;
  expires_at: string | null;
  session_timeout_seconds: number;
  photos_available?: boolean;
  biometric_devices?: number;
  /** Why the PIN can't be checked right now, if it can't - the vault then stays locked. */
  security?: {
    problem: SecurityProblem | null;
    lockout?: {retry_after: number; failed_attempts: number; lockouts: number; state_damaged: boolean};
  };
  encryption?: {
    available: boolean;
    state: 'off' | 'encrypting' | 'interrupted' | 'on';
    problem: SecurityProblem | null;
    recovery_key: boolean;
  };
}

export type SecurityProblem =
  | 'pin_unreadable'
  | 'pin_tampered'
  | 'key_unavailable'
  | 'keyring_damaged'
  | 'encryption_unavailable';

export interface VaultItem {
  path: string;
  name: string;
  folder?: string;
  size: number;
  modified: string | null;
  media_type: 'photo' | 'video' | 'file';
  content_type: string;
  encrypted?: boolean;
  /** An encrypted file that failed its integrity check - it can't be opened. */
  damaged?: boolean;
}

export interface MoveResult {
  moved: {id?: string; path?: string}[];
  failed: {id?: string; path?: string; reason: string}[];
}

/** An error from the Locked Folder, with the wait when it was a lockout. */
export class LockedFolderError extends ApiError {
  constructor(message: string, status: number, public retryAfter = 0) {
    super(message, status);
  }
}

function failure(body: any, status: number, fallback: string): LockedFolderError {
  const retryAfter = Number(body?.retry_after) || 0;
  return new LockedFolderError(body?.error || fallback, status, retryAfter);
}

/**
 * The Locked Folder satellite's API (satellites/native/locked_folder/api.py).
 * Every route here is authorized on the server against this session's own
 * unlock - nothing in the app is trusted to decide that.
 */
export class LockedFolderApi {
  constructor(private client: StarCoreClient) {}

  /** Null when this server has no Locked Folder satellite at all. */
  async status(): Promise<LockedFolderStatus | null> {
    const {status, body} = await this.client.get(`${BASE}/status`);
    if (status === 404) {
      return null;
    }
    if (status !== 200) {
      throw failure(body, status, 'Could not check the Locked Folder.');
    }
    return body as LockedFolderStatus;
  }

  async unlock(pin: string): Promise<void> {
    const {status, body} = await this.client.post(`${BASE}/unlock`, {pin});
    if (status !== 200) {
      throw failure(body, status, 'Could not unlock the Locked Folder.');
    }
  }

  async lock(): Promise<void> {
    await this.client.post(`${BASE}/lock`, {});
  }

  async setPin(pin: string, currentPin?: string): Promise<void> {
    const {status, body} = await this.client.post(
      `${BASE}/pin`,
      currentPin === undefined ? {pin} : {pin, current_pin: currentPin},
    );
    if (status !== 200) {
      throw failure(body, status, 'Could not save the PIN.');
    }
  }

  async media(): Promise<VaultItem[]> {
    const {status, body} = await this.client.get(`${BASE}/media`);
    if (status !== 200) {
      throw failure(body, status, 'Could not open the Locked Folder.');
    }
    return (body.items ?? []) as VaultItem[];
  }

  /** The URL of one vault file; it needs the session's bearer token. */
  filePath(path: string): string {
    return `${BASE}/media/file?path=${encodeURIComponent(path)}`;
  }

  async moveIn(photoIds: string[]): Promise<MoveResult> {
    return this.move('move_in', {photo_ids: photoIds});
  }

  async moveOut(paths: string[]): Promise<MoveResult> {
    return this.move('move_out', {paths});
  }

  private async move(route: string, payload: object): Promise<MoveResult> {
    const {status, body} = await this.client.post(`${BASE}/${route}`, payload);
    if (status === 200 || status === 409) {
      const result = body as MoveResult;
      if (result.failed?.length && !result.moved?.length) {
        throw new LockedFolderError(result.failed[0].reason, status);
      }
      return result;
    }
    throw failure(body, status, 'Could not move this.');
  }

  async enrollBiometrics(pin: string, publicKey: string, deviceName: string): Promise<string> {
    const {status, body} = await this.client.post(`${BASE}/biometric/enroll`, {
      pin,
      public_key: publicKey,
      device_name: deviceName,
    });
    if (status !== 200 || typeof body.key_id !== 'string') {
      throw failure(body, status, 'Could not turn on biometric unlock.');
    }
    return body.key_id;
  }

  /** Null when the server no longer knows this device's key. */
  async biometricChallenge(keyId: string): Promise<string | null> {
    const {status, body} = await this.client.post(`${BASE}/biometric/challenge`, {key_id: keyId});
    if (status === 404) {
      return null;
    }
    if (status !== 200 || typeof body.challenge !== 'string') {
      throw failure(body, status, 'Could not start biometric unlock.');
    }
    return body.challenge;
  }

  async biometricUnlock(keyId: string, challenge: string, signature: string): Promise<void> {
    const {status, body} = await this.client.post(`${BASE}/biometric/unlock`, {
      key_id: keyId,
      challenge,
      signature,
    });
    if (status !== 200) {
      throw failure(body, status, 'Biometric unlock failed.');
    }
  }

  async revokeBiometrics(keyId: string): Promise<void> {
    await this.client.post(`${BASE}/biometric/revoke`, {key_id: keyId});
  }
}
