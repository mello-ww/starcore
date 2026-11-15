import {useMemo} from 'react';
import {useAuth} from '../auth/AuthContext';
import {biometricSigner} from '../platform/biometrics';
import {secureStorage} from '../platform/secureStorage';
import {useServers} from '../servers/ServersContext';
import type {CapabilityProvider} from '../satellites/ui/contract';
import {VaultApi} from './api';
import type {BiometricDeps} from './biometricUnlock';

/** A media.vault provider's routes on the active server, and what biometric unlock needs when
 * the provider offers it (null otherwise: the PIN only). */
export function useVault(provider: CapabilityProvider): {api: VaultApi; biometricDeps: BiometricDeps | null} {
  const {client} = useAuth();
  const {activeServer} = useServers();
  const serverId = activeServer?.id ?? '';
  const api = useMemo(() => new VaultApi(client, provider), [client, provider]);
  const biometricDeps = useMemo(
    () => (api.biometrics ? {api, signer: biometricSigner, store: secureStorage, serverId, provider: provider.satellite} : null),
    [api, serverId, provider.satellite],
  );
  return {api, biometricDeps};
}
