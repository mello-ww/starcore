import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import type {HistoryPeriod, SeriesName, StatusHistory, StatusSnapshot, StatusSummary} from './types';

const BASE = '/api/satellites/status';

/**
 * The Status satellite's own routes - the same ones Mission Control's Status
 * page reads (see satellites/native/status/api.py). Nothing here measures
 * anything: every number comes from the server's sampler.
 */
export class StatusApi {
  constructor(private client: StarCoreClient) {}

  async metrics(): Promise<StatusSnapshot> {
    const {status, body} = await this.client.get(`${BASE}/metrics`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load Status.', status);
    }
    return body as StatusSnapshot;
  }

  async history(period: HistoryPeriod, series?: SeriesName[], points?: number): Promise<StatusHistory> {
    const query = [`period=${encodeURIComponent(period)}`];
    if (series?.length) {
      query.push(`series=${series.map(encodeURIComponent).join(',')}`);
    }
    if (points) {
      query.push(`points=${Math.round(points)}`);
    }
    const {status, body} = await this.client.get(`${BASE}/history?${query.join('&')}`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load the history.', status);
    }
    return body as StatusHistory;
  }
}

/** The Status satellite's published summary, read from a satellite listing
 * Home already has - or null when this server's Status doesn't publish one. */
export function statusSummary(state: Record<string, unknown> | undefined): StatusSummary | null {
  if (!state || (state.health !== 'ok' && state.health !== 'warning' && state.health !== 'critical')) {
    return null;
  }
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    health: state.health,
    cpu_percent: number(state.cpu_percent),
    memory_percent: number(state.memory_percent),
    satellites_online: number(state.satellites_online),
    satellites_total: number(state.satellites_total),
    warnings: Array.isArray(state.warnings) ? state.warnings.filter((item): item is string => typeof item === 'string') : [],
    warning_count: number(state.warning_count) ?? 0,
  };
}
