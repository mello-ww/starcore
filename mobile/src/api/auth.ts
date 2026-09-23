import {SESSION_KIND} from '../config';
import {StarCoreClient} from './client';
import {ApiError, AuthStatus} from './types';

/** What `SessionManager` (src/auth/session.ts) actually depends on - an
 * interface, not the concrete `AuthApi` class below, so a test can supply
 * a trivial fake instead of a real `StarCoreClient` and a live server. */
export interface AuthApiClient {
  status(): Promise<AuthStatus>;
  login(username: string, password: string, deviceName: string): Promise<string>;
  logout(): Promise<void>;
}

/**
 * The `/api/auth/*` endpoints this app needs - see docs/api.md,
 * "Authentication", in the main repository. Every call here is exactly the
 * request/response shape StarCore's own auth system already defines;
 * nothing is reinterpreted or renamed on this side.
 */
export class AuthApi implements AuthApiClient {
  constructor(private client: StarCoreClient) {}

  async status(): Promise<AuthStatus> {
    const {status, body} = await this.client.get('/api/auth/status');
    if (status !== 200) {
      throw new ApiError('Could not check StarCore status.', status);
    }
    return body as AuthStatus;
  }

  /** Logs in with `kind: "mobile"` (see AuthStore.create_session in the
   * server) so this session shows up distinctly in StarCore's "Active
   * sessions" list, and gets the issued token back directly in the
   * response body - see the `kind === "mobile"` branch of
   * `_handle_auth_login` in `engine/starcore/api/server.py` for why that's
   * necessary (a native HTTP stack doesn't expose Set-Cookie to
   * application code the way a browser's fetch() does). Returns the raw
   * token string; storing it is the caller's (src/auth/session.ts's) job,
   * not this one's - this module only ever talks to the server. */
  async login(username: string, password: string, deviceName: string): Promise<string> {
    const {status, body} = await this.client.post(
      '/api/auth/login',
      {username, password, kind: SESSION_KIND, device_name: deviceName},
      {authenticate: false},
    );
    if (status !== 200 || typeof body.token !== 'string' || !body.token) {
      throw new ApiError(body?.error || 'Invalid username or password.', status);
    }
    return body.token;
  }

  /** Best-effort - the caller (session.ts) clears local storage regardless
   * of whether this succeeds, since "am I logged out" must never depend on
   * StarCore being reachable right now. */
  async logout(): Promise<void> {
    await this.client.post('/api/auth/logout');
  }
}
