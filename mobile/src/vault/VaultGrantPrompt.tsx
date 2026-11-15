import React, {useCallback, useEffect, useRef} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {SecurePrompt, SecurePromptProps} from '../satellites/ui/secure';
import {palette, space, type} from '../theme/tokens';
import {grantWithBiometrics} from './biometricUnlock';
import {useVault} from './useVault';
import {VaultUnlock} from './VaultUnlock';

/**
 * The app's answer to a secure action (media.vault, UI contract 1.2): its own unlock card - the
 * PIN, and biometrics when this phone turned them on for the provider - asking the provider's
 * unlock for a single-use grant for exactly the items being moved instead of opening the store.
 * Attempts, lockouts and the biometric challenge are the provider's as always. The PIN never
 * leaves this card except to the provider's own unlock route; only the grant goes back.
 */
export function VaultGrantPrompt({count, wanted, provider, onGrant, onCancel}: SecurePromptProps) {
  const {api, biometricDeps} = useVault(provider);
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
    if (!biometricDeps) {
      return 'not-enrolled' as const;
    }
    const {result, grant} = await grantWithBiometrics(biometricDeps, 'Move it into the protected folder', wanted);
    granted.current = grant;
    return result;
  }, [biometricDeps, wanted]);

  const what = count === 1 ? 'this item' : `these ${count} items`;
  return (
    <Modal transparent animationType="fade" onRequestClose={() => settle(null)} statusBarTranslucent>
      <View style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
          <VaultUnlock
            biometricDeps={biometricDeps}
            title="Enter your PIN"
            intro={`To move ${what} into the protected folder. It stays locked.`}
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

/** What the composition root registers for the secure action: the app's own prompt for
 * media.vault, whichever Satellite the catalog says provides it. */
export const VAULT_GRANT_PROMPT: SecurePrompt = {capability: 'media.vault', component: VaultGrantPrompt};

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.75)'},
  center: {flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.sm},
  cancel: {alignSelf: 'center', paddingVertical: space.sm, paddingHorizontal: space.lg},
  cancelText: {...type.label, color: palette.text2},
  pressed: {opacity: 0.6},
});
