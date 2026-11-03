import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, tokens, typography, useAccentStyles} from '../theme';
import {isEnrolled, unlockWithBiometrics} from './biometricUnlock';
import type {BiometricDeps} from './biometricUnlock';
import type {LockedFolderApi} from './api';

/**
 * The locked state: PIN entry, plus "Use biometrics" when this phone has
 * turned it on for this server. Biometrics are offered once automatically
 * when this appears, and the PIN always works as the fallback.
 */
export function LockedFolderUnlock({
  api,
  biometricDeps,
  onUnlocked,
  intro = 'Enter your PIN to see what’s inside.',
  autoBiometrics = true,
  forgotHelp,
}: {
  api: LockedFolderApi;
  biometricDeps: BiometricDeps;
  onUnlocked: () => void;
  intro?: string;
  autoBiometrics?: boolean;
  /** What to do about a forgotten PIN, behind a "Forgot your PIN?" link. */
  forgotHelp?: string;
}) {
  const accentStyle = useAccentStyles();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [enrolled, setEnrolled] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const tried = useRef(false);

  useEffect(() => {
    if (wait <= 0) {
      return;
    }
    const timer = setTimeout(() => setWait(left => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const lockedOut = (error: any) => {
    if (error?.retryAfter > 0) {
      setWait(error.retryAfter);
      setMessage(null);
      return true;
    }
    return false;
  };

  const tryBiometrics = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await unlockWithBiometrics(biometricDeps, 'Unlock the Locked Folder');
      if (result === 'unlocked') {
        onUnlocked();
        return;
      }
      if (result === 'reenroll') {
        setEnrolled(false);
        setMessage('Biometric unlock was turned off because your fingerprints, face or PIN changed. Use your PIN.');
      } else if (result === 'failed') {
        setMessage('Biometric unlock didn’t work. Use your PIN.');
      } else if (result === 'unavailable') {
        setMessage('Biometrics aren’t available right now. Use your PIN.');
      }
    } catch (error: any) {
      if (!lockedOut(error)) {
        setMessage(error?.message || 'Could not unlock.');
      }
    } finally {
      setBusy(false);
    }
  }, [biometricDeps, onUnlocked]);

  useEffect(() => {
    isEnrolled(biometricDeps).then(value => {
      setEnrolled(value);
      if (value && autoBiometrics && !tried.current) {
        tried.current = true;
        tryBiometrics();
      }
    });
  }, [biometricDeps, autoBiometrics, tryBiometrics]);

  const submit = async () => {
    if (!pin) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.unlock(pin);
      setPin('');
      onUnlocked();
    } catch (error: any) {
      setPin('');
      if (!lockedOut(error)) {
        setMessage(error?.status === 401 ? 'Incorrect PIN.' : error?.message || 'Could not unlock.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Icon name="lock" size={36} color={accentStyle.color} />
      <Text style={typography.heading}>Locked Folder is locked</Text>
      <Text style={[typography.caption, styles.center]}>{intro}</Text>
      <TextInput
        value={pin}
        onChangeText={text => setPin(text.replace(/\D/g, ''))}
        placeholder="PIN"
        placeholderTextColor={colors.textFaint}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={12}
        editable={!busy && wait <= 0}
        onSubmitEditing={submit}
        style={styles.input}
        accessibilityLabel="PIN"
        autoComplete="off"
        importantForAutofill="no"
      />
      {wait > 0 ? (
        <Text style={[styles.message, styles.center]}>Too many incorrect attempts. Try again in {formatWait(wait)}.</Text>
      ) : message ? (
        <Text style={[styles.message, styles.center]} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <PrimaryButton title="Unlock" onPress={submit} disabled={!pin || wait > 0} loading={busy} />
        {enrolled && (
          <PrimaryButton title="Use biometrics" variant="secondary" onPress={tryBiometrics} disabled={busy || wait > 0} />
        )}
      </View>
      {forgotHelp ? (
        showForgot ? (
          <Text style={[typography.caption, styles.center]}>{forgotHelp}</Text>
        ) : (
          <Pressable
            onPress={() => setShowForgot(true)}
            accessibilityRole="button"
            hitSlop={12}
            style={styles.forgot}>
            <Text style={[typography.caption, accentStyle.text]}>Forgot your PIN?</Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}

export function formatWait(seconds: number): string {
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

const styles = StyleSheet.create({
  forgot: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: tokens.radii.card,
    backgroundColor: colors.surface,
  },
  center: {textAlign: 'center'},
  input: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: tokens.radii.control,
    borderWidth: 1,
    borderColor: tokens.palette.controlStrong,
    backgroundColor: tokens.palette.field,
    color: colors.text,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
  },
  message: {color: colors.alert, fontSize: 13},
  actions: {alignSelf: 'stretch', gap: spacing.sm, marginTop: spacing.xs},
});
