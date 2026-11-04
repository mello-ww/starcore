import {REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS} from '../config';
import {ApiError, UploadableFile} from './types';

// re-exported so callers (photo/api.ts) can `import {StarCoreClient,
// UploadableFile} from '../api/client'` in one line, rather than reaching
// into './types' separately just for this one type
export type {UploadableFile};

export type TokenProvider = () => Promise<string | null>;

/**
 * A thin wrapper around `fetch`, talking to the exact same `/api/...`
 * StarCore already serves to Mission Control - see docs/api.md in the main
 * repository. This is the *only* place in the app that builds a request
 * URL or reads a response; every other module (api/auth.ts, and File
 * Explorer/Photo Library/Locked Folder clients added in later blocks) goes
 * through an instance of this class rather than calling `fetch` itself, so
 * there is exactly one place that knows how StarCore's API is shaped and
 * one place a future change (a new base path, a new auth header) would
 * need to happen.
 *
 * Never talks to two different servers at once and never invents its own
 * endpoints - see "Do not create a second backend" in mobile/README.md.
 */
export class StarCoreClient {
  constructor(
    private baseUrl: string,
    /** Reads the current session token from secure storage on every call,
     * rather than being handed one at construction time - so a
     * `StarCoreClient` created once at app start always uses whatever
     * token is current, including right after a fresh login replaces it. */
    private getToken: TokenProvider = async () => null,
  ) {}

  /** `headers` adds request headers, e.g. If-None-Match to revalidate a
   * cached UI document (satellites/ui/api.ts) - a 304 comes back as
   * status 304 with an empty body. */
  get(path: string, headers?: Record<string, string>): Promise<{status: number; body: any; finalUrl: string}> {
    return this.request('GET', path, undefined, true, headers);
  }

  post(
    path: string,
    body?: unknown,
    options: {authenticate?: boolean} = {},
  ): Promise<{status: number; body: any; finalUrl: string}> {
    return this.request('POST', path, body, options.authenticate ?? true);
  }

  /** Uploads a file already on the device as a raw request body - matching
   * what a route like Photo's sync_upload_route expects (request.raw, never
   * JSON or multipart form data - see its own docstring). Passing an object
   * shaped `{uri, type, name}` as fetch's own `body` is React Native's own
   * documented way to stream a local file's bytes straight from disk,
   * without ever reading them into a JS string first - the same reason
   * backgroundSync.ts's own CameraRollSource only ever hands this class a
   * `uri`, never file contents.
   *
   * Uses UPLOAD_TIMEOUT_MS, not REQUEST_TIMEOUT_MS: a phone video upload
   * over a slow connection can legitimately take minutes, where every other
   * request in this app should fail fast. */
  async postFile(path: string, file: UploadableFile): Promise<{status: number; body: any; finalUrl: string}> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {'Content-Type': file.type || 'application/octet-stream'};
      const token = await this.getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: {uri: file.uri, type: file.type, name: file.name},
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return {status: response.status, body: parsed, finalUrl: response.url};
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new ApiError('The upload to StarCore timed out.', 0);
      }
      throw new ApiError('Could not reach StarCore. Check the server address and your connection.', 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    authenticate: boolean,
    extraHeaders?: Record<string, string>,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {...extraHeaders};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (authenticate) {
        const token = await this.getToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        // a non-JSON response (StarCore's own HTML frontend, an unexpected
        // proxy error page) - callers only ever look at `status` in that case
        parsed = {};
      }
      // `response.url` is the URL actually served, after following any
      // redirects (e.g. a reverse proxy forcing http -> https) - see
      // servers/testConnection.ts, which uses this to stop pointing later
      // requests at an address that just redirects them.
      return {status: response.status, body: parsed, finalUrl: response.url};
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new ApiError('The request to StarCore timed out.', 0);
      }
      // a network failure (server unreachable, TLS error, DNS failure, ...) -
      // status 0 is not a real HTTP status, used here only so callers can
      // tell "we never got a response at all" apart from a real 4xx/5xx
      throw new ApiError('Could not reach StarCore. Check the server address and your connection.', 0);
    } finally {
      clearTimeout(timeout);
    }
  }
}
