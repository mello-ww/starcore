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

/** A file already living on the device, ready to upload as a raw request
 * body (see StarCoreClient.postFile) - a local `uri`, never bytes read into
 * JS memory here. Used by Photo's background sync (photo/api.ts's
 * uploadSync) to send a phone photo/video straight from the camera roll. */
export interface UploadableFile {
  uri: string;
  name: string;
  type: string;
}
