import AsyncStorage from '@react-native-async-storage/async-storage';
import {ApiError} from '../src/api/types';
import {clearCachedDocuments, UiApi} from '../src/satellites/ui/api';

const DOCUMENT = {contract: 'starcore.ui/1.0', entry: 'home', pages: {home: {blocks: []}}};

function fakeClient(responses: Array<{status: number; body: any} | Error>) {
  const get = jest.fn(async (...request: unknown[]) => {
    void request; // the calls are asserted through get.mock
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return {...next!, finalUrl: ''};
  });
  const post = jest.fn(async () => ({status: 200, body: {message: 'ok'}, finalUrl: ''}));
  return {client: {get, post} as any, get, post};
}

/**
 * UI documents are cached per server and revalidated with their revision
 * (docs/ui-contract.md, "Caching and discovery"). The cache stands in for a
 * definition only while the server is unreachable - never for a session the
 * server refused, and never for page data.
 */
describe('UiApi', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('fetches, validates and caches a document per server', async () => {
    const {client, get} = fakeClient([{status: 200, body: {revision: 'r1', document: DOCUMENT}}]);
    const loaded = await new UiApi(client, 'srv-1').document('Notes');
    expect(loaded).toEqual({document: DOCUMENT, revision: 'r1', offline: false});
    expect(get).toHaveBeenCalledWith('/api/satellites/Notes/ui', undefined);
    expect(await AsyncStorage.getItem('starcore_ui_doc:v1:srv-1:Notes')).toContain('"r1"');
    expect(await AsyncStorage.getItem('starcore_ui_doc:v1:srv-2:Notes')).toBeNull();
  });

  it('opens a cached document of the revision the server reported without a request', async () => {
    const first = fakeClient([{status: 200, body: {revision: 'r1', document: DOCUMENT}}]);
    await new UiApi(first.client, 'srv-1').document('Notes');
    const second = fakeClient([]);
    expect((await new UiApi(second.client, 'srv-1').document('Notes', 'r1')).revision).toBe('r1');
    expect(second.get).not.toHaveBeenCalled();
  });

  it('revalidates an older copy with If-None-Match and keeps it on 304', async () => {
    const first = fakeClient([{status: 200, body: {revision: 'r1', document: DOCUMENT}}]);
    await new UiApi(first.client, 'srv-1').document('Notes');
    const second = fakeClient([{status: 304, body: {}}]);
    const loaded = await new UiApi(second.client, 'srv-1').document('Notes', 'r2');
    expect(second.get).toHaveBeenCalledWith('/api/satellites/Notes/ui', {'If-None-Match': '"r1"'});
    expect(loaded.revision).toBe('r1');
  });

  it('falls back to the cached layout only when the server is unreachable', async () => {
    const first = fakeClient([{status: 200, body: {revision: 'r1', document: DOCUMENT}}]);
    await new UiApi(first.client, 'srv-1').document('Notes');
    const offline = fakeClient([new ApiError('Could not reach StarCore.', 0)]);
    expect((await new UiApi(offline.client, 'srv-1').document('Notes')).offline).toBe(true);
  });

  it('never answers a refused session from the cache', async () => {
    const first = fakeClient([{status: 200, body: {revision: 'r1', document: DOCUMENT}}]);
    await new UiApi(first.client, 'srv-1').document('Notes');
    const refused = fakeClient([{status: 401, body: {error: 'authentication required'}}]);
    await expect(new UiApi(refused.client, 'srv-1').document('Notes')).rejects.toMatchObject({status: 401});
  });

  it('refuses a document this app cannot render', async () => {
    const {client} = fakeClient([{status: 200, body: {revision: 'r9', document: {...DOCUMENT, contract: 'starcore.ui/2.0'}}}]);
    await expect(new UiApi(client, 'srv-1').document('Notes')).rejects.toThrow('starcore.ui/2.0');
    expect(await AsyncStorage.getItem('starcore_ui_doc:v1:srv-1:Notes')).toBeNull();
  });

  it('only ever calls routes beneath the Satellite', async () => {
    const {client, get, post} = fakeClient([{status: 200, body: {ok: true}}]);
    const api = new UiApi(client, 'srv-1');
    await api.read('Notes', 'items/a%20b');
    expect(get).toHaveBeenCalledWith('/api/satellites/Notes/items/a%20b');
    await expect(api.read('Notes', '../Music/library')).rejects.toThrow('outside');
    await expect(api.act('Notes', 'disable', 'POST', {})).rejects.toThrow('outside');
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a server without /api/catalog as having no providers', async () => {
    const {client} = fakeClient([{status: 404, body: {error: 'unknown endpoint'}}]);
    expect(await new UiApi(client, 'srv-1').providers()).toEqual({});
  });

  it('forgets one server’s documents on request', async () => {
    await AsyncStorage.setItem('starcore_ui_doc:v1:srv-1:A', '{}');
    await AsyncStorage.setItem('starcore_ui_doc:v1:srv-2:A', '{}');
    await clearCachedDocuments('srv-1');
    expect(await AsyncStorage.getItem('starcore_ui_doc:v1:srv-1:A')).toBeNull();
    expect(await AsyncStorage.getItem('starcore_ui_doc:v1:srv-2:A')).toBe('{}');
  });
});
