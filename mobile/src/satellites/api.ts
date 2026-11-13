import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import type {SatelliteSummary} from './types';

/**
 * The Satellite endpoint this app needs - `GET /api/satellites` (already
 * used by Mission Control). Not a second API: the call is exactly the shape
 * the server already defines. A Satellite's own interface is its `ui.json`,
 * fetched by `UiApi` (src/satellites/ui/api.ts).
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
}
