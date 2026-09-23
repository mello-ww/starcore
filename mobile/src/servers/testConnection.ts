import {StarCoreClient} from '../api/client';

/** Accepts an address with or without an explicit scheme - see "Accept
 * addresses with or without http://" in the task brief. Defaults to plain
 * HTTP, matching StarCore's own LAN-first deployment default
 * (docs/deployment.md); an address that already names a scheme is left
 * alone (aside from trimming a trailing slash) so HTTPS still works. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return trimmed;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export type ConnectionCheck = {ok: true} | {ok: false; message: string};

/** Actually reaches the server before the caller treats it as connected -
 * see "Do not silently treat an incorrect or unreachable server as
 * successfully connected" in the task brief. `/api/auth/status` is
 * StarCore's lightest always-open endpoint (see docs/api.md): answerable
 * whether or not the server has been bootstrapped yet, so it doubles as a
 * pure reachability probe. Checking the response shape (not just the HTTP
 * status) catches an address that answers with 200 but isn't StarCore at
 * all - a router's admin page, a captive portal, etc. */
export async function testConnection(baseUrl: string): Promise<ConnectionCheck> {
  try {
    const client = new StarCoreClient(baseUrl);
    const {status, body} = await client.get('/api/auth/status');
    if (status !== 200 || typeof body?.bootstrapped !== 'boolean') {
      return {ok: false, message: 'That address did not respond like a StarCore server.'};
    }
    return {ok: true};
  } catch (error: any) {
    return {ok: false, message: error?.message || 'Could not reach StarCore. Check the address and try again.'};
  }
}
