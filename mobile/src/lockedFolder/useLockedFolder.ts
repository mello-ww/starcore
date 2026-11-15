import {useMemo} from 'react';
import {useAuth} from '../auth/AuthContext';
import {biometricSigner} from '../platform/biometrics';
import {secureStorage} from '../platform/secureStorage';
import {useServers} from '../servers/ServersContext';
import type {BiometricDeps} from '../vault/biometricUnlock';
import {LOCKED_FOLDER, LockedFolderApi} from './api';

/** The Locked Folder API for the active server, plus what biometric unlock
 * needs. Biometrics here are the Locked Folder's own, separate from the
 * app's biometric app lock - the same enrollment the app's shared unlock
 * card (src/vault/) finds for this provider. */
export function useLockedFolder() {
  const {client, state} = useAuth();
  const {activeServer} = useServers();
  const api = useMemo(() => new LockedFolderApi(client), [client]);
  const serverId = activeServer?.id ?? '';
  const baseUrl = activeServer?.baseUrl ?? '';
  const token = state.status === 'signed-in' ? state.session.token : null;
  const biometricDeps: BiometricDeps<LockedFolderApi> = useMemo(
    () => ({api, signer: biometricSigner, store: secureStorage, serverId, provider: LOCKED_FOLDER}),
    [api, serverId],
  );
  return {api, serverId, baseUrl, token, biometricDeps};
}
