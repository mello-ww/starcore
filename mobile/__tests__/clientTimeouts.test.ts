/**
 * StarCoreClient's request timeout: an ordinary JSON request fails fast after
 * REQUEST_TIMEOUT_MS, and its timer never outlives the request.
 */
import {StarCoreClient} from '../src/api/client';
import {REQUEST_TIMEOUT_MS} from '../src/config';

const originalFetch = globalThis.fetch;
let signals: AbortSignal[];

/** A fetch that never answers on its own - it only settles by rejecting
 * with an AbortError once the client's own AbortController fires. */
function installHangingFetch() {
  signals = [];
  globalThis.fetch = jest.fn((_url: any, init: any) => {
    signals.push(init.signal);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }) as unknown as typeof fetch;
}

function installAnsweringFetch() {
  globalThis.fetch = jest.fn(() =>
    Promise.resolve({status: 200, url: 'http://starcore.test/x', text: () => Promise.resolve('{"ok":true}')}),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('ordinary requests', () => {
  it('still time out after REQUEST_TIMEOUT_MS', async () => {
    installHangingFetch();
    const client = new StarCoreClient('http://starcore.test');

    const request = client.get('/api/status');
    const outcome = expect(request).rejects.toMatchObject({
      message: 'The request to StarCore timed out.',
      status: 0,
    });

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await outcome;
  });

  it('clear their timer once answered', async () => {
    installAnsweringFetch();
    const client = new StarCoreClient('http://starcore.test');

    const result = await client.get('/api/status');

    expect(result.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });
});
