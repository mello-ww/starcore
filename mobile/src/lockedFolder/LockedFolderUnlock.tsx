import React, {useCallback} from 'react';
import {unlockWithBiometrics} from '../vault/biometricUnlock';
import type {BiometricDeps, BiometricUnlockResult} from '../vault/biometricUnlock';
import {formatWait, VaultUnlock} from '../vault/VaultUnlock';
import type {LockedFolderApi} from './api';

export {formatWait};

/**
 * The Locked Folder's locked state in its own screens: the app's shared unlock card
 * (src/vault/VaultUnlock.tsx) with the Locked Folder's words, unlocking it for this session
 * unless `withPin` / `withBiometrics` say otherwise.
 */
export function LockedFolderUnlock({
  api,
  biometricDeps,
  onUnlocked,
  intro = 'Enter your PIN to see what’s inside.',
  title = 'Locked Folder is locked',
  autoBiometrics = true,
  forgotHelp,
  withPin,
  withBiometrics,
}: {
  api: LockedFolderApi;
  biometricDeps: BiometricDeps;
  onUnlocked: () => void;
  intro?: string;
  title?: string;
  autoBiometrics?: boolean;
  /** What to do about a forgotten PIN, behind a "Forgot your PIN?" link. */
  forgotHelp?: string;
  /** Instead of unlocking the vault (a single-use grant, say): what the PIN does. Throws as
   * api.unlock() does. */
  withPin?: (pin: string) => Promise<void>;
  /** ...and what a biometric match does. */
  withBiometrics?: () => Promise<BiometricUnlockResult>;
}) {
  const pinUnlock = useCallback((pin: string) => (withPin ? withPin(pin) : api.unlock(pin)), [api, withPin]);
  const biometricUnlock = useCallback(
    () => (withBiometrics ? withBiometrics() : unlockWithBiometrics(biometricDeps, 'Unlock the Locked Folder')),
    [biometricDeps, withBiometrics],
  );
  return (
    <VaultUnlock
      withPin={pinUnlock}
      withBiometrics={biometricUnlock}
      biometricDeps={biometricDeps}
      onUnlocked={onUnlocked}
      title={title}
      intro={intro}
      autoBiometrics={autoBiometrics}
      forgotHelp={forgotHelp}
    />
  );
}
