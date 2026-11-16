import type {StarCoreClient} from '../api/client';
import type {CapabilityProvider} from '../satellites/ui/contract';
import type {SyncNative, SyncState} from './native';

/** A setup step that failed, with words for the person. */
export class SyncSetupError extends Error {}

/** The device credentials endpoint (a signed-in session asks for one limited to a capability). */
const DEVICES = '/api/auth/devices';
const REVOKE = '/api/auth/sessions/revoke';

/**
 * Turns the backup on for this server: asks the Engine for a device credential limited to the
 * capability (it reaches only the provider's own operations, and reads nothing), then hands it,
 * the server's origin and the provider's operation routes (from the catalog) to the Kotlin sync
 * package, which runs from then on without the app.
 */
export async function setUpSync({
  client,
  native,
  serverId,
  origin,
  capability,
  provider,
}: {
  client: StarCoreClient;
  native: SyncNative;
  serverId: string;
  origin: string;
  capability: string;
  provider: CapabilityProvider;
}): Promise<SyncState> {
  const {status: statusRoute, check, upload} = provider.operations ?? {};
  if (!statusRoute || !check || !upload) {
    throw new SyncSetupError("The server's backup is missing an operation this app needs.");
  }
  const {status, body} = await client.post(DEVICES, {capability, device_name: native.deviceName});
  if (status === 409) {
    throw new SyncSetupError(body?.error || 'This server has as many devices as it allows. Remove one first.');
  }
  if (status < 200 || status >= 300 || typeof body?.token !== 'string') {
    throw new SyncSetupError(body?.error || 'The server did not let this phone back up.');
  }
  return native.configure(serverId, {
    origin,
    satellite: provider.satellite,
    routes: {status: statusRoute, check, upload},
    device: native.deviceName,
    token: body.token,
    sessionId: typeof body.session_id === 'string' ? body.session_id : null,
  });
}

/**
 * Signing out: everything the backup kept for this server goes (its work, settings, index and
 * credential), and the credential is revoked while the session still can. Never throws: signing
 * out goes on whatever happens here.
 */
export async function forgetSync(native: SyncNative | null, serverId: string, client?: StarCoreClient): Promise<void> {
  if (!native) {
    return;
  }
  try {
    const sessionId = await native.forget(serverId);
    if (sessionId && client) {
      await client.post(REVOKE, {session_id: sessionId});
    }
  } catch {
    // nothing kept, or the server unreachable: the credential can be revoked from its list
  }
}
