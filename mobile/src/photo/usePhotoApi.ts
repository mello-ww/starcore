import {useMemo} from 'react';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {PhotoApi, photoImageSource} from './api';

/**
 * Everything a Photos screen needs from the rest of the app, in one place:
 * a PhotoApi bound to the active server's authenticated client, the active
 * server's own id (for namespacing the offline cache - see cache.ts) and
 * base URL, and a helper to build an authenticated image source. Every
 * Photos screen calls this once instead of re-deriving the same four
 * things from useAuth()/useServers() itself.
 */
export function usePhotoApi() {
  const {client, state} = useAuth();
  const {activeServer} = useServers();
  const api = useMemo(() => new PhotoApi(client), [client]);
  const token = state.status === 'signed-in' ? state.session.token : null;
  const baseUrl = activeServer?.baseUrl ?? '';
  const serverId = activeServer?.id ?? '';

  const imageSource = useMemo(
    () => (photoId: string, kind: 'thumbnail' | 'original' = 'thumbnail', trashed = false) =>
      photoImageSource(baseUrl, token, photoId, kind, trashed),
    [baseUrl, token],
  );

  return {api, serverId, baseUrl, token, imageSource};
}
