import AsyncStorage from '@react-native-async-storage/async-storage';
import {StarCoreClient} from '../../api/client';
import {ApiError} from '../../api/types';
import {checkDocument, isSafeRoute, MAJOR, type Providers, type UiDocument} from './contract';

/**
 * The UI contract endpoints - `GET /api/satellites/<name>/ui` (a Satellite's
 * ui.json, ETag = its revision), `GET /api/catalog` (capability providers)
 * and the Satellite's own routes a document binds to. See docs/ui-contract.md.
 *
 * Documents are cached per server and per contract major, and revalidated
 * with If-None-Match, so a screen paints at once and a 304 costs no body.
 * The cache only ever stands in for the *definition* while the server is
 * unreachable: page data is always fetched live, and a 401/403 is never
 * answered from the cache - the server alone decides what this session may do.
 */
const KEY_PREFIX = `starcore_ui_doc:v${MAJOR}`;

export interface LoadedDocument {
  document: UiDocument;
  revision: string;
  /** true when the server couldn't be reached and this is the last copy seen */
  offline: boolean;
}

function cacheKey(serverId: string, satellite: string): string {
  return `${KEY_PREFIX}:${serverId}:${satellite}`;
}

async function readCache(serverId: string, satellite: string): Promise<{document: UiDocument; revision: string} | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(serverId, satellite));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.revision === 'string' && checkDocument(parsed.document) === null) {
      return parsed;
    }
  } catch {
    // an unreadable cache entry is simply a cache miss
  }
  return null;
}

export class UiApi {
  constructor(private client: StarCoreClient, private serverId: string) {}

  private satellitePath(satellite: string, route: string): string {
    if (!isSafeRoute(route)) {
      throw new ApiError('That points outside its Satellite and was refused.', 0);
    }
    return `/api/satellites/${encodeURIComponent(satellite)}/${route}`;
  }

  /** The Satellite's document. `knownRevision` (from GET /api/satellites)
   * lets a cached copy of that exact revision skip the network entirely. */
  async document(satellite: string, knownRevision?: string | null): Promise<LoadedDocument> {
    const cached = await readCache(this.serverId, satellite);
    if (cached && knownRevision && cached.revision === knownRevision) {
      return {...cached, offline: false};
    }
    let response: {status: number; body: any};
    try {
      response = await this.client.get(
        `/api/satellites/${encodeURIComponent(satellite)}/ui`,
        cached ? {'If-None-Match': `"${cached.revision}"`} : undefined,
      );
    } catch (error: any) {
      if (cached && error?.status === 0) {
        return {...cached, offline: true};
      }
      throw error;
    }
    if (response.status === 304 && cached) {
      return {...cached, offline: false};
    }
    if (response.status !== 200) {
      throw new ApiError(response.body?.error || 'Could not load this interface.', response.status);
    }
    const problem = checkDocument(response.body?.document);
    if (problem) {
      throw new ApiError(problem, 200);
    }
    const loaded = {document: response.body.document as UiDocument, revision: String(response.body.revision)};
    try {
      await AsyncStorage.setItem(cacheKey(this.serverId, satellite), JSON.stringify(loaded));
    } catch {
      // caching is a convenience; the screen works without it
    }
    return {...loaded, offline: false};
  }

  /** Capability providers - an older server without /api/catalog has none. */
  async providers(): Promise<Providers> {
    try {
      const {status, body} = await this.client.get('/api/catalog');
      return status === 200 && body?.capabilities ? body.capabilities : {};
    } catch {
      return {};
    }
  }

  async read(satellite: string, route: string): Promise<any> {
    const {status, body} = await this.client.get(this.satellitePath(satellite, route));
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load this page.', status);
    }
    return body;
  }

  async act(satellite: string, route: string, method: 'GET' | 'POST', payload: unknown): Promise<any> {
    const path = this.satellitePath(satellite, route);
    const {status, body} = method === 'GET' ? await this.client.get(path) : await this.client.post(path, payload ?? {});
    if (status < 200 || status >= 300) {
      throw new ApiError(body?.error || 'That action failed.', status);
    }
    return body;
  }
}

/** Forget every cached document for a server - e.g. after Rediscover. */
export async function clearCachedDocuments(serverId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter(key => key.startsWith(`${KEY_PREFIX}:${serverId}:`));
    if (mine.length) {
      await AsyncStorage.multiRemove(mine);
    }
  } catch {
    // nothing cached, or storage unavailable - either way nothing to clear
  }
}
