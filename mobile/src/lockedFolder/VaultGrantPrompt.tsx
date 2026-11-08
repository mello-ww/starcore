import React, {useCallback, useEffect, useRef} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {SecurePrompt, SecurePromptProps} from '../satellites/ui/secure';
import {palette, space, type} from '../theme/tokens';
import {LOCKED_FOLDER} from './api';
import {grantWithBiometrics} from './biometricUnlock';
import {LockedFolderUnlock} from './LockedFolderUnlock';
import {useLockedFolder} from './useLockedFolder';

/**
 * The Locked Folder's answer to a secure action (media.vault, UI contract 1.2): its own unlock
 * screen - the PIN, and biometrics when this phone turned them on - asking for a single-use
 * grant for exactly the items being moved instead of opening the vault. Attempts, lockouts and
 * the biometric challenge are the Locked Folder's as always. The PIN never leaves this screen
 * except to the Locked Folder's own unlock route; only the grant goes back.
 */
export function VaultGrantPrompt({count, wanted, onGrant, onCancel}: SecurePromptProps) {
  const {api, biometricDeps} = useLockedFolder();
  const granted = useRef<string | null>(null);
  const settled = useRef(false);
  const handlers = useRef({onGrant, onCancel});
  handlers.current = {onGrant, onCancel};

  const settle = useCallback((grant: string | null) => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    if (grant) {
      handlers.current.onGrant(grant);
    } else {
      handlers.current.onCancel();
    }
  }, []);
  useEffect(() => () => settle(null), [settle]); // closed any other way: nothing was granted

  const withPin = useCallback(async (pin: string) => {
    granted.current = await api.grant(pin, wanted);
  }, [api, wanted]);
  const withBiometrics = useCallback(async () => {
    const {result, grant} = await grantWithBiometrics(biometricDeps, 'Move to the Locked Folder', wanted);
    granted.current = grant;
    return result;
  }, [biometricDeps, wanted]);

  const what = count === 1 ? 'this item' : `these ${count} items`;
  return (
    <Modal transparent animationType="fade" onRequestClose={() => settle(null)} statusBarTranslucent>
      <View style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
          <LockedFolderUnlock
            api={api}
            biometricDeps={biometricDeps}
            title="Move to the Locked Folder"
            intro={`Enter your PIN to move ${what}. The Locked Folder stays locked.`}
            withPin={withPin}
            withBiometrics={withBiometrics}
            onUnlocked={() => settle(granted.current)}
          />
          <Pressable
            onPress={() => settle(null)}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({pressed}) => [styles.cancel, pressed && styles.pressed]}
            testID="vault-grant-cancel">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** What the composition root registers: this prompt speaks the Locked Folder's own unlock, so it
 * answers only for media.vault as the Locked Folder provides it. */
export const VAULT_GRANT_PROMPT: SecurePrompt = {capability: 'media.vault', satellite: LOCKED_FOLDER, component: VaultGrantPrompt};

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.75)'},
  center: {flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.sm},
  cancel: {alignSelf: 'center', paddingVertical: space.sm, paddingHorizontal: space.lg},
  cancelText: {...type.label, color: palette.text2},
  pressed: {opacity: 0.6},
});
