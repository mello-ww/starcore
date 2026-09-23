import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import type {MobileUiResponse, SatelliteSummary, UiAction} from './types';

/**
 * The Satellite endpoints this app needs - `GET /api/satellites` (already
 * used by Mission Control) and `GET /api/satellites/<name>/mobile` (see
 * "Exposing a mobile interface" in docs/satellites.md). Not a second API:
 * every call here is exactly the shape the server already defines.
 */
export class SatellitesApi {
  constructor(private client: StarCoreClient) {}

  async list(): Promise<SatelliteSummary[]> {
    const {status, body} = await this.client.get('/api/satellites');
    if (status !== 200) {
      throw new ApiError('Could not load Satellites.', status);
    }
    return (body.satellites ?? []) as SatelliteSummary[];
  }

  async mobileUi(satelliteName: string): Promise<MobileUiResponse> {
    const {status, body} = await this.client.get(`/api/satellites/${encodeURIComponent(satelliteName)}/mobile`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load this Satellite.', status);
    }
    return body as MobileUiResponse;
  }

  /** Runs a `button` item's action (see UiAction) - resolved relative to
   * this Satellite's own routes unless it names an absolute path. */
  async runAction(satelliteName: string, action: UiAction): Promise<unknown> {
    const path = action.route.startsWith('/')
      ? action.route
      : `/api/satellites/${encodeURIComponent(satelliteName)}/${action.route}`;
    const {status, body} =
      action.method === 'POST' ? await this.client.post(path) : await this.client.get(path);
    if (status < 200 || status >= 300) {
      throw new ApiError(body?.error || 'That action failed.', status);
    }
    return body;
  }
}
