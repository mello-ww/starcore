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

export type ConnectionCheck = {ok: true; resolvedBaseUrl: string} | {ok: false; message: string};

/** The origin (scheme + host[:port]) a URL was actually served from, or
 * null if it can't be parsed - this project has no @types/node and no
 * guaranteed `URL` global across RN versions, so a plain regex rather than
 * `new URL(...).origin`. */
function originOf(url: string | undefined): string | null {
  const match = /^https?:\/\/[^/]+/i.exec(url ?? '');
  return match ? match[0] : null;
}

/** Actually reaches the server before the caller treats it as connected -
 * see "Do not silently treat an incorrect or unreachable server as
 * successfully connected" in the task brief. `/api/auth/status` is
 * StarCore's lightest always-open endpoint (see docs/api.md): answerable
 * whether or not the server has been bootstrapped yet, so it doubles as a
 * pure reachability probe. Checking the response shape (not just the HTTP
 * status) catches an address that answers with 200 but isn't StarCore at
 * all - a router's admin page, a captive portal, etc.
 *
 * `resolvedBaseUrl` is the origin the request actually ended up at, after
 * following any redirect - e.g. a reverse proxy that forces plain `http://`
 * onto `https://`, as duckdns.org deployments commonly do. GET requests
 * (this check) follow such a redirect transparently, but a POST (login)
 * doesn't get the same guarantee - some HTTP clients replay a 301/302'd
 * POST as a GET, which is exactly what "requires POST" server errors on
 * login turn out to mean. Callers store `resolvedBaseUrl`, not whatever the
 * user typed, so every later request (including login) goes straight to
 * the real address and never touches the redirect at all. */
export async function testConnection(baseUrl: string): Promise<ConnectionCheck> {
  try {
    const client = new StarCoreClient(baseUrl);
    const {status, body, finalUrl} = await client.get('/api/auth/status');
    if (status !== 200 || typeof body?.bootstrapped !== 'boolean') {
      return {ok: false, message: 'That address did not respond like a StarCore server.'};
    }
    return {ok: true, resolvedBaseUrl: originOf(finalUrl) ?? baseUrl};
  } catch (error: any) {
    return {ok: false, message: error?.message || 'Could not reach StarCore. Check the address and try again.'};
  }
}
