import {REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS} from '../config';
import {ApiError} from './types';

export type TokenProvider = () => Promise<string | null>;

/** A local file to upload as-is, from its own URI - never read into JS
 * memory first. React Native's fetch treats this shape specially and
 * streams it from disk/the content provider itself, which matters for a
 * phone video that can be well over 100MB. Used only by Photo's background
 * sync (see photo/backgroundSync.ts); every other write in this app is
 * small enough for the normal JSON post() below. */
export interface UploadableFile {
  uri: string;
  name: string;
  type: string;
}

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

  get(path: string): Promise<{status: number; body: any; finalUrl: string}> {
    return this.request('GET', path, undefined, true);
  }

  post(
    path: string,
    body?: unknown,
    options: {authenticate?: boolean} = {},
  ): Promise<{status: number; body: any; finalUrl: string}> {
    return this.request('POST', path, body, options.authenticate ?? true);
  }

  /** Posts a local file's raw bytes (never JSON) - used by Photo's
   * background sync to reach api.py's `sync_upload` route. A generous,
   * separate timeout from ordinary JSON calls: a phone video upload over a
   * slow connection can legitimately take minutes, where every other
   * request in this app should fail fast (see REQUEST_TIMEOUT_MS). */
  async postFile(path: string, file: UploadableFile): Promise<{status: number; body: any}> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {};
      const token = await this.getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        // React Native's fetch accepts a {uri, name, type} object as a body
        // and streams it from disk itself - not part of the standard
        // BodyInit type, hence the cast.
        body: file as unknown as BodyInit,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return {status: response.status, body: parsed};
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new ApiError('The upload to StarCore timed out.', 0);
      }
      throw new ApiError('Could not reach StarCore. Check the server address and your connection.', 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, authenticate: boolean) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {};
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
