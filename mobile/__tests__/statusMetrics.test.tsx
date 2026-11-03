import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {StatusApi} from '../src/status/api';
import {MetricsState, HistoryState, useStatusHistory, useStatusMetrics} from '../src/status/hooks';
import {history, snapshot} from './statusFixtures';

function fakeApi() {
  return {metrics: jest.fn(), history: jest.fn()} as unknown as StatusApi & {metrics: jest.Mock; history: jest.Mock};
}

let seen: MetricsState | null = null;
function MetricsProbe({api, active}: {api: StatusApi; active: boolean}) {
  seen = useStatusMetrics(api, active);
  return null;
}

let seenHistory: HistoryState | null = null;
function HistoryProbe({api, period, active}: {api: StatusApi; period: '1h' | '24h'; active: boolean}) {
  seenHistory = useStatusHistory(api, period, active, {refreshSeconds: 60});
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useStatusMetrics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    seen = null;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls once per server sample, only while active', async () => {
    const api = fakeApi();
    api.metrics.mockResolvedValue(snapshot({interval: 5}));
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<MetricsProbe api={api} active />);
    });
    await flush();
    expect(api.metrics).toHaveBeenCalledTimes(1);
    expect(seen!.data?.node.name).toBe('atlas');
    expect(seen!.loading).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(api.metrics).toHaveBeenCalledTimes(2);

    act(() => tree.update(<MetricsProbe api={api} active={false} />));
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(api.metrics).toHaveBeenCalledTimes(2);

    act(() => tree.update(<MetricsProbe api={api} active />));
    await flush();
    expect(api.metrics).toHaveBeenCalledTimes(3); // a fresh reading on coming back
    act(() => tree.unmount());
  });

  it('follows the interval the server reports', async () => {
    const api = fakeApi();
    api.metrics.mockResolvedValue(snapshot({interval: 10}));
    act(() => {
      renderer.create(<MetricsProbe api={api} active />);
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(api.metrics).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(api.metrics).toHaveBeenCalledTimes(2);
  });

  it('keeps the last snapshot and marks it stale when a request fails', async () => {
    const api = fakeApi();
    api.metrics.mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error('Network request failed'));
    act(() => {
      renderer.create(<MetricsProbe api={api} active />);
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(seen!.data?.cpu?.percent).toBe(29.8);
    expect(seen!.error).toBe('Network request failed');
    expect(seen!.stale).toBe(true);
  });

  it('reports an error without data as an error, not as loading', async () => {
    const api = fakeApi();
    api.metrics.mockRejectedValue(new Error('authentication required'));
    act(() => {
      renderer.create(<MetricsProbe api={api} active />);
    });
    await flush();
    expect(seen!.data).toBeNull();
    expect(seen!.loading).toBe(false);
    expect(seen!.stale).toBe(false);
    expect(seen!.error).toBe('authentication required');
  });

  it('never overlaps a slow request with the next one', async () => {
    const api = fakeApi();
    let resolve!: (value: unknown) => void;
    api.metrics.mockImplementation(() => new Promise(done => (resolve = done)));
    act(() => {
      renderer.create(<MetricsProbe api={api} active />);
    });
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(api.metrics).toHaveBeenCalledTimes(1);
    await act(async () => resolve(snapshot()));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(api.metrics).toHaveBeenCalledTimes(2);
  });
});

describe('useStatusHistory', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    seenHistory = null;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refetches when the period changes and ignores an answer that arrives late', async () => {
    const api = fakeApi();
    const answers: Record<string, (value: unknown) => void> = {};
    api.history.mockImplementation((period: string) => new Promise(done => (answers[period] = done)));
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<HistoryProbe api={api} period="24h" active />);
    });
    act(() => tree.update(<HistoryProbe api={api} period="1h" active />));
    await act(async () => answers['1h'](history({period: '1h'})));
    await act(async () => answers['24h'](history({period: '24h'})));
    expect(seenHistory!.data?.period).toBe('1h');
    expect(seenHistory!.loading).toBe(false);
  });

  it('refreshes on its own schedule while active', async () => {
    const api = fakeApi();
    api.history.mockResolvedValue(history());
    act(() => {
      renderer.create(<HistoryProbe api={api} period="24h" active />);
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(api.history).toHaveBeenCalledTimes(2);
  });
});
