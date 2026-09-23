/** Mirrors the shapes StarCore's own API already returns - see docs/api.md
 * in the main repository. Nothing here invents a new response format; this
 * app is a client of the existing API, not a second implementation of it. */

export interface AuthStatus {
  bootstrapped: boolean;
  authenticated: boolean;
}

export interface SessionInfo {
  session_id: string;
  kind: 'web' | 'mobile';
  device_name: string | null;
  created: number;
  expires: number;
  current: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}
