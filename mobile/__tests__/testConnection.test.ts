import {normalizeServerUrl, testConnection} from '../src/servers/testConnection';

describe('normalizeServerUrl', () => {
  it('adds http:// to a bare host', () => {
    expect(normalizeServerUrl('192.168.1.20:8090')).toBe('http://192.168.1.20:8090');
  });

  it('leaves an explicit https:// address alone', () => {
    expect(normalizeServerUrl('https://starcore.example.com')).toBe('https://starcore.example.com');
  });

  it('leaves an explicit http:// address alone', () => {
    expect(normalizeServerUrl('http://192.168.1.20:8090')).toBe('http://192.168.1.20:8090');
  });

  it('trims a trailing slash', () => {
    expect(normalizeServerUrl('http://192.168.1.20:8090/')).toBe('http://192.168.1.20:8090');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServerUrl('  192.168.1.20:8090  ')).toBe('http://192.168.1.20:8090');
  });
});

/**
 * testConnection() is what stands between "the address looks like a URL"
 * and "this server is actually reachable" - see "Do not silently treat an
 * incorrect or unreachable server as successfully connected" in the task
 * brief. fetch is mocked directly rather than the StarCoreClient it's
 * built on, so this exercises the real request/response handling.
 */
describe('testConnection', () => {
  // `globalThis`, not Node's `global` - this project has no @types/node, so
  // `global` doesn't typecheck here (see tsconfig.json); `globalThis` is
  // the same object under Jest and needs no extra types.
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('succeeds against a real StarCore server', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      url: 'http://192.168.1.20:8090/api/auth/status',
      text: async () => JSON.stringify({bootstrapped: true, authenticated: false}),
    }) as any;

    expect(await testConnection('http://192.168.1.20:8090')).toEqual({
      ok: true,
      resolvedBaseUrl: 'http://192.168.1.20:8090',
    });
  });

  /**
   * A reverse proxy (duckdns.org and similar deployments commonly do this)
   * that redirects plain http:// to https:// - GET follows it transparently
   * (this check succeeds), but a POST can come back downgraded to a GET on
   * some HTTP clients, which is what a login's "requires POST" server error
   * actually means. Storing the *resolved* origin instead of what the user
   * typed means login never touches the redirect in the first place - see
   * testConnection's own doc comment.
   */
  it('resolves to the address actually served, after a redirect', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      url: 'https://starcore-panel.duckdns.org/api/auth/status',
      text: async () => JSON.stringify({bootstrapped: true, authenticated: false}),
    }) as any;

    expect(await testConnection('http://starcore-panel.duckdns.org')).toEqual({
      ok: true,
      resolvedBaseUrl: 'https://starcore-panel.duckdns.org',
    });
  });

  it('fails with a clear message when the server is unreachable', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as any;

    const result = await testConnection('http://192.168.1.20:9999');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/could not reach starcore/i);
    }
  });

  it('fails when something answers but is not StarCore', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => '<html>this is a router admin page, not StarCore</html>',
    }) as any;

    expect((await testConnection('http://192.168.1.20:80')).ok).toBe(false);
  });

  it('fails on a non-200 response instead of treating it as connected', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({status: 404, text: async () => ''}) as any;

    expect((await testConnection('http://192.168.1.20:8090')).ok).toBe(false);
  });
});
