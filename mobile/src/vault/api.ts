import type {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import {isSafeRoute, type CapabilityProvider} from '../satellites/ui/contract';
import type {GrantRequest} from '../satellites/ui/secure';
import type {EnrollingBiometricApi} from './biometricUnlock';

/**
 * A media.vault provider's routes (contracts/ui/vocabulary.json), as the catalog names them: what
 * the app's own unlock prompt and a protected document's gate call. Generic - the provider is
 * whichever Satellite the catalog says offers the capability, and every route is that
 * provider's own operation. The server alone decides what an unlock opens; nothing here is
 * trusted to.
 */

/** What status answers (the vocabulary's media.vault status); providers may add keys. */
export interface VaultStatus {
  configured: boolean;
  pin_set: boolean;
  pin_unreadable?: boolean;
  unlocked: boolean;
  expires_at: string | null;
  session_timeout_seconds?: number;
  idle_seconds?: number;
  security?: {problem: string | null; lockout?: {retry_after: number}};
  [key: string]: unknown;
}

/** A refusal from the store, with the wait when it was a lockout. */
export class VaultError extends ApiError {
  constructor(message: string, status: number, public retryAfter = 0) {
    super(message, status);
  }
}

function failure(body: any, status: number, fallback: string): VaultError {
  return new VaultError(body?.error || fallback, status, Number(body?.retry_after) || 0);
}

export class VaultApi implements EnrollingBiometricApi {
  constructor(private client: StarCoreClient, readonly provider: CapabilityProvider) {}

  /** The provider's route for an operation, or null when it doesn't offer it. */
  private path(operation: string, rest = ''): string | null {
    const route = this.provider.operations?.[operation];
    if (typeof route !== 'string' || !isSafeRoute(route)) {
      return null;
    }
    return `/api/satellites/${encodeURIComponent(this.provider.satellite)}/${route}${rest}`;
  }

  private async post(operation: string, body: unknown, fallback: string, rest = ''): Promise<{status: number; body: any}> {
    const path = this.path(operation, rest);
    if (!path) {
      throw new VaultError(fallback, 0);
    }
    const {status, body: answer} = await this.client.post(path, body);
    return {status, body: answer};
  }

  /** Whether this provider offers biometric unlock (an optional operation). */
  get biometrics(): boolean {
    return this.path('biometric') !== null;
  }

  async status(): Promise<VaultStatus> {
    const path = this.path('status');
    if (!path) {
      throw new VaultError('This store can’t be checked.', 0);
    }
    const {status, body} = await this.client.get(path);
    if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) {
      throw failure(body, status, 'Could not check whether it is locked.');
    }
    return body as VaultStatus;
  }

  /** A full unlock of this session: what a protected document asks for. */
  async unlock(pin: string): Promise<void> {
    const {status, body} = await this.post('unlock', {pin}, 'Could not unlock it.');
    if (status !== 200) {
      throw failure(body, status, 'Could not unlock it.');
    }
    if (body?.unlocked !== true) {
      throw new VaultError('The unlock didn’t open it.', status);
    }
  }

  /** A single-use grant for one operation on exactly these items: the store stays locked. */
  async grant(pin: string, wanted: GrantRequest): Promise<string> {
    const {status, body} = await this.post('unlock', {pin, for: wanted}, 'Could not unlock for this.');
    if (status !== 200 || typeof body?.grant !== 'string') {
      throw failure(body, status, 'Could not unlock for this.');
    }
    return body.grant;
  }

  async lock(): Promise<void> {
    await this.post('lock', {}, 'Could not lock it.');
  }

  /** Tells the store a protected document still shows it; a 403 means it is locked again. */
  async keep(): Promise<void> {
    const {status, body} = await this.post('keep', {}, 'Could not keep it open.');
    if (status !== 200) {
      throw failure(body, status, 'Could not keep it open.');
    }
  }

  /** What the signature will be for is decided here, with the challenge: `wanted` for a
   * single-use grant, nothing for a full unlock. Null when the store no longer knows this key. */
  async biometricChallenge(keyId: string, wanted?: GrantRequest): Promise<string | null> {
    const {status, body} = await this.post(
      'biometric',
      wanted ? {key_id: keyId, for: wanted} : {key_id: keyId},
      'Could not start biometric unlock.',
      '/challenge',
    );
    if (status === 404) {
      return null;
    }
    if (status !== 200 || typeof body?.challenge !== 'string') {
      throw failure(body, status, 'Could not start biometric unlock.');
    }
    return body.challenge;
  }

  /** Resolves the grant when the challenge was asked for one, null after a full unlock. */
  async biometricUnlock(keyId: string, challenge: string, signature: string): Promise<string | null> {
    const {status, body} = await this.post(
      'biometric',
      {key_id: keyId, challenge, signature},
      'Biometric unlock failed.',
      '/unlock',
    );
    if (status !== 200) {
      throw failure(body, status, 'Biometric unlock failed.');
    }
    return typeof body?.grant === 'string' ? body.grant : null;
  }

  /** Registers this phone's public key for biometric unlock; the PIN proves it is the owner. */
  async enrollBiometrics(pin: string, publicKey: string, deviceName: string): Promise<string> {
    const {status, body} = await this.post(
      'biometric',
      {pin, public_key: publicKey, device_name: deviceName},
      'Could not turn on biometric unlock.',
      '/enroll',
    );
    if (status !== 200 || typeof body?.key_id !== 'string') {
      throw failure(body, status, 'Could not turn on biometric unlock.');
    }
    return body.key_id;
  }

  async revokeBiometrics(keyId: string): Promise<void> {
    await this.post('biometric', {key_id: keyId}, 'Could not turn biometric unlock off.', '/revoke');
  }
}
