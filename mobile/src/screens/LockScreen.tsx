import React, {useEffect, useRef, useState} from 'react';
import {Alert, BackHandler, Pressable, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import type {UnlockResult} from '../auth/appLock';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography, useAccentStyles} from '../theme';

const MESSAGES: Partial<Record<UnlockResult, string>> = {
  cancelled: 'Unlock was cancelled. Tap Unlock to try again.',
  'not-enrolled':
    'No fingerprint is enrolled on this device. Add one in Android Settings, or sign in with your password.',
  unavailable: 'Biometric unlock is not available right now. Try again, or sign in with your password.',
};

/**
 * Shown instead of (or on top of) the signed-in app while AuthContext
 * reports `locked`. Prompts once when it appears; after a cancel, a tap
 * outside the system prompt or a failure the user retries with the button,
 * so a dismissed prompt never loops - and never changes anything stored.
 *
 * Back (the visible button and Android hardware back) returns to the
 * server list through `onBack`: it never authenticates, never turns the
 * lock off and never touches the session.
 *
 * "Sign in with password" is the recovery path when biometrics can't be
 * used (all fingerprints removed, sensor broken). It signs this device out
 * of this server and needs the real StarCore password - it is not a way
 * around the lock - and the stored biometric preference is kept.
 */
export function LockScreen({onBack}: {onBack?: () => void}) {
  const accentStyle = useAccentStyles();
  const {unlock, logout} = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const prompted = useRef(false);

  const tryUnlock = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await unlock();
      setMessage(MESSAGES[result] ?? null);
    } catch {
      setMessage(MESSAGES.unavailable!);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!prompted.current) {
      prompted.current = true;
      tryUnlock();
    }
    // prompt once per appearance only
  }, []);

  useEffect(() => {
    // the navigator may still be mounted underneath; hardware back must not
    // reach it. Back goes to the server list, or leaves the app if there is
    // nowhere to go.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (onBack) {
        onBack();
      } else {
        BackHandler.exitApp();
      }
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  const confirmPasswordSignIn = () => {
    Alert.alert(
      'Sign in with your password?',
      'This signs this device out of this server and asks for your StarCore password. Biometric unlock stays turned on.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Continue', onPress: () => logout()},
      ],
    );
  };

  return (
    <View style={styles.screen} testID="lock-screen">
      <View style={styles.content}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={12} testID="lock-back-button">
            <Text style={[styles.back, accentStyle.text]}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={typography.title}>StarCore is locked</Text>
        <Text style={[typography.caption, styles.subtitle]}>Unlock with your fingerprint to continue.</Text>
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <PrimaryButton title="Unlock" onPress={tryUnlock} loading={busy} />
        <PrimaryButton title="Sign in with password" variant="secondary" onPress={confirmPasswordSignIn} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {...StyleSheet.absoluteFillObject, backgroundColor: colors.void},
  content: {flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md},
  subtitle: {marginBottom: spacing.md},
  back: {fontSize: 16, marginBottom: spacing.sm},
  error: {color: colors.alert, fontSize: 13, marginBottom: spacing.sm},
});
