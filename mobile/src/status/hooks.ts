import {useCallback, useEffect, useRef, useState} from 'react';
import type {StatusApi} from './api';
import type {HistoryPeriod, SeriesName, StatusHistory, StatusSnapshot} from './types';

/** How often to ask before the server has said how often it samples. */
export const DEFAULT_INTERVAL_SECONDS = 5;
const MIN_INTERVAL_SECONDS = 2;

export {useAppActive} from '../hooks/useAppActive';

export interface MetricsState {
  data: StatusSnapshot | null;
  error: string | null;
  /** Nothing has loaded yet and nothing has failed yet. */
  loading: boolean;
  /** The last request failed, so `data` is what the server said earlier. */
  stale: boolean;
  /** When `data` last arrived (ms since the epoch), for "updated 12s ago". */
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

/**
 * The one poller behind every Status section: GET /metrics every time the
 * server samples (its own `interval`), only while `active` - the screen is
 * focused and the app in the foreground. A failed request keeps the last
 * snapshot on screen and marks it stale instead of blanking the view, and a
 * slow request is never overlapped by the next one.
 */
export function useStatusMetrics(api: StatusApi, active: boolean): MetricsState {
  const [data, setData] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    try {
      const snapshot = await api.metrics();
      if (mounted.current) {
        setData(snapshot);
        setError(null);
        setUpdatedAt(Date.now());
      }
    } catch (err: any) {
      if (mounted.current) {
        setError(err?.message || 'Could not reach Status.');
      }
    } finally {
      busy.current = false;
    }
  }, [api]);

  const seconds = Math.max(MIN_INTERVAL_SECONDS, data?.interval ?? DEFAULT_INTERVAL_SECONDS);

  // a fresh reading the moment the screen comes back, then one per sample
  useEffect(() => {
    if (active) {
      load();
    }
  }, [active, load]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(load, seconds * 1000);
    return () => clearInterval(timer);
  }, [active, load, seconds]);

  return {data, error, loading: !data && !error, stale: Boolean(data && error), updatedAt, refresh: load};
}

export interface HistoryState {
  data: StatusHistory | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * One history request, refetched when its period changes and every
 * `refreshSeconds` while `active`. While a new period loads, the previous
 * chart stays on screen (callers dim it with `loading`).
 */
export function useStatusHistory(
  api: StatusApi,
  period: HistoryPeriod,
  active: boolean,
  options: {series?: SeriesName[]; points?: number; refreshSeconds?: number} = {},
): HistoryState {
  const {series, points, refreshSeconds = 60} = options;
  const [data, setData] = useState<StatusHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const latest = useRef(0);
  const seriesKey = series?.join(',') ?? '';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const history = await api.history(period, seriesKey ? (seriesKey.split(',') as SeriesName[]) : undefined, points);
      // a slower answer for an earlier period never replaces a newer one
      if (mounted.current && request === latest.current) {
        setData(history);
        setError(null);
      }
    } catch (err: any) {
      if (mounted.current && request === latest.current) {
        setError(err?.message || 'Could not load the history.');
      }
    } finally {
      if (mounted.current && request === latest.current) {
        setLoading(false);
      }
    }
  }, [api, period, seriesKey, points]);

  useEffect(() => {
    if (active) {
      load();
    }
  }, [active, load]);

  useEffect(() => {
    if (!active || !refreshSeconds) {
      return undefined;
    }
    const timer = setInterval(load, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [active, load, refreshSeconds]);

  return {data, error, loading, refresh: load};
}
