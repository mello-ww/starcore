/**
 * Regression tests for StarCoreClient's two timeouts: ordinary JSON requests
 * fail fast after REQUEST_TIMEOUT_MS, while postFile() (Photo's background
 * sync uploads, which can be large videos on a slow connection) gets the
 * much longer UPLOAD_TIMEOUT_MS. postFile once accidentally used the short
 * one, which nothing caught - hence these tests.
 */
import {StarCoreClient} from '../src/api/client';
import {ApiError} from '../src/api/types';
import {REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS} from '../src/config';

const FILE = {uri: 'file:///video.mp4', name: 'video.mp4', type: 'video/mp4'};

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

it('gives uploads a longer timeout than ordinary requests', () => {
  expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
});

describe('postFile', () => {
  it('is not aborted once the ordinary request timeout has passed', async () => {
    installHangingFetch();
    const client = new StarCoreClient('http://starcore.test');

    const upload = client.postFile('/upload', FILE);
    upload.catch(() => {}); // settled later in this test; avoid an unhandled rejection meanwhile
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    await expect(upload).rejects.toBeInstanceOf(ApiError);
  });

  it('is aborted with an upload timeout error after UPLOAD_TIMEOUT_MS', async () => {
    installHangingFetch();
    const client = new StarCoreClient('http://starcore.test');

    const upload = client.postFile('/upload', FILE);
    const outcome = expect(upload).rejects.toMatchObject({
      message: 'The upload to StarCore timed out.',
      status: 0,
    });

    await jest.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - 1);
    expect(signals[0].aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await outcome;
  });

  it('clears its timer once the upload finishes', async () => {
    installAnsweringFetch();
    const client = new StarCoreClient('http://starcore.test');

    const result = await client.postFile('/upload', FILE);

    expect(result.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });
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
});
