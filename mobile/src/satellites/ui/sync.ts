import {CLIENT_CAPABILITIES, type CapabilityProvider, type Providers} from './contract';

/** What the sync action (1.2) opens: {Satellite capability: the client capability that is this
 * app's own sync screen for it}. Kept equal to the vocabulary's sync_capabilities. */
export const SYNC_CAPABILITIES: Record<string, string> = {'media.sync': 'device.media-sync'};

/** The protocol versions of each sync capability this app's sync screen speaks. */
export const SYNC_VERSIONS: Record<string, number[]> = {'media.sync': [1]};

/** The screen the sync action pushes, with {satellite, capability}. */
export const SYNC_SCREEN = 'MediaSync';

/** Where a sync action ({sync: {capability}}) leads in this app: the document's own Satellite as
 * the capability's enabled provider, in a version the sync screen speaks, and the client
 * capability that screen is - or null, and the control is hidden. The document supplies nothing
 * else: the screen is the app's. */
export function syncTarget(
  action: any,
  providers: Providers | null | undefined,
  satellite: string,
): {provider: CapabilityProvider; capability: string} | null {
  const capability = action?.sync && typeof action.sync === 'object' ? action.sync.capability : undefined;
  if (typeof capability !== 'string' || !Object.prototype.hasOwnProperty.call(SYNC_CAPABILITIES, capability)) {
    return null;
  }
  if (!CLIENT_CAPABILITIES.has(SYNC_CAPABILITIES[capability])) {
    return null;
  }
  const versions = SYNC_VERSIONS[capability] ?? [];
  const provider = (providers?.[capability] ?? []).find(
    entry => entry.enabled && entry.satellite === satellite && versions.includes(entry.version),
  );
  return provider ? {provider, capability} : null;
}

/** The provider the sync screen backs up to: the named Satellite's when it was opened from a
 * document, otherwise the server's first, enabled and in a version the screen speaks - or
 * null (the server takes no backups). */
export function syncProvider(
  providers: Providers | null | undefined,
  capability: string,
  satellite?: string,
): CapabilityProvider | null {
  if (!Object.prototype.hasOwnProperty.call(SYNC_CAPABILITIES, capability) || !CLIENT_CAPABILITIES.has(SYNC_CAPABILITIES[capability])) {
    return null;
  }
  const versions = SYNC_VERSIONS[capability] ?? [];
  return (
    (providers?.[capability] ?? []).find(
      entry => entry.enabled && versions.includes(entry.version) && (!satellite || entry.satellite === satellite),
    ) ?? null
  );
}
