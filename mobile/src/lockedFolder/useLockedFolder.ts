import {useMemo} from 'react';
import {useAuth} from '../auth/AuthContext';
import {biometricSigner} from '../platform/biometrics';
import {secureStorage} from '../platform/secureStorage';
import {useServers} from '../servers/ServersContext';
import {LockedFolderApi} from './api';
import type {BiometricDeps} from './biometricUnlock';

/** The Locked Folder API for the active server, plus what biometric unlock
 * needs. Biometrics here are the Locked Folder's own, separate from the
 * app's biometric app lock. */
export function useLockedFolder() {
  const {client, state} = useAuth();
  const {activeServer} = useServers();
  const api = useMemo(() => new LockedFolderApi(client), [client]);
  const serverId = activeServer?.id ?? '';
  const baseUrl = activeServer?.baseUrl ?? '';
  const token = state.status === 'signed-in' ? state.session.token : null;
  const biometricDeps: BiometricDeps = useMemo(
    () => ({api, signer: biometricSigner, store: secureStorage, serverId}),
    [api, serverId],
  );
  return {api, serverId, baseUrl, token, biometricDeps};
}
