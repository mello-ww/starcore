import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {PrimaryButton} from '../components/PrimaryButton';
import {StarSwitch} from '../components/StarSwitch';
import {deviceInfo} from '../platform/device';
import {colors, spacing, tokens, typography, useAccentStyles} from '../theme';
import {canEnroll, disable, enroll, isEnrolled, unlockWithBiometrics} from './biometricUnlock';
import type {BiometricDeps, BiometricUnlockResult} from './biometricUnlock';

/**
 * The app's own unlock card for a media.vault store: PIN entry, plus "Use biometrics" when this
 * phone has turned it on for this server and store. Biometrics are offered once automatically
 * when this appears, and the PIN always works as the fallback. What the PIN and a match do is
 * the caller's - a full unlock for a protected document, a single-use grant for the secure
 * action. The PIN lives only in the field and the requests it is sent with.
 *
 * With `offerBiometrics` (a full unlock), a phone that can use biometrics but hasn't turned them
 * on for this store offers "Use biometrics next time": the PIN that unlocks also turns them on.
 * One that has offers to stop using them on this phone.
 */
export function VaultUnlock({
  withPin,
  withBiometrics,
  biometricDeps,
  onUnlocked,
  title = 'It’s locked',
  intro = 'Enter your PIN to see what’s inside.',
  biometricPrompt,
  autoBiometrics = true,
  offerBiometrics = false,
  onForgot,
}: {
  /** What the PIN does; throws as the store's unlock does (401 wrong, `retryAfter` locked out). */
  withPin: (pin: string) => Promise<void>;
  /** What a biometric match does; a full unlock by default. */
  withBiometrics?: () => Promise<BiometricUnlockResult>;
  /** Biometrics are offered only with these, and when this phone enrolled for the store. */
  biometricDeps?: BiometricDeps | null;
  onUnlocked: () => void;
  title?: string;
  intro?: string;
  /** The system biometric prompt's words; the title by default. */
  biometricPrompt?: string;
  autoBiometrics?: boolean;
  /** Offer to turn biometric unlock on with the PIN, or off: for a full unlock only. */
  offerBiometrics?: boolean;
  /** What "Forgot your PIN?" opens (a protected document's forgot page). */
  onForgot?: () => void;
}) {
  const accentStyle = useAccentStyles();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [enrolled, setEnrolled] = useState(false);
  // whether this phone could turn biometrics on here, and whether the person wants that
  const [enrollable, setEnrollable] = useState(false);
  const [remember, setRemember] = useState(false);
  const tried = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

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
    if (!biometricDeps) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = withBiometrics
        ? await withBiometrics()
        : await unlockWithBiometrics(biometricDeps, biometricPrompt ?? title);
      if (!mounted.current) {
        return;
      }
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
      if (mounted.current && !lockedOut(error)) {
        setMessage(error?.message || 'Could not unlock.');
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [biometricDeps, biometricPrompt, title, onUnlocked, withBiometrics]);

  useEffect(() => {
    if (!biometricDeps) {
      setEnrolled(false);
      return;
    }
    isEnrolled(biometricDeps).then(value => {
      if (!mounted.current) {
        return;
      }
      setEnrolled(value);
      if (value && autoBiometrics && !tried.current) {
        tried.current = true;
        tryBiometrics();
      }
    });
  }, [biometricDeps, autoBiometrics, tryBiometrics]);

  useEffect(() => {
    if (!offerBiometrics || !biometricDeps || !canEnroll(biometricDeps) || enrolled) {
      setEnrollable(false);
      return;
    }
    Promise.resolve()
      .then(() => biometricDeps.signer.isAvailable())
      .then(result => mounted.current && setEnrollable(Boolean(result?.available)))
      .catch(() => mounted.current && setEnrollable(false));
  }, [offerBiometrics, biometricDeps, enrolled]);

  const stopBiometrics = async () => {
    if (!biometricDeps) {
      return;
    }
    await disable(biometricDeps).catch(() => undefined);
    if (mounted.current) {
      setEnrolled(false); // and "Use biometrics next time" is offered again
    }
  };

  const submit = async () => {
    if (!pin) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await withPin(pin);
      if (enrollable && remember && biometricDeps && canEnroll(biometricDeps)) {
        // unlocked already: biometrics that can't be turned on now are simply not on
        await enroll(biometricDeps, pin, deviceInfo.displayName()).catch(() => false);
      }
      if (!mounted.current) {
        return;
      }
      setPin('');
      onUnlocked();
    } catch (error: any) {
      if (!mounted.current) {
        return;
      }
      setPin('');
      if (!lockedOut(error)) {
        setMessage(error?.status === 401 ? 'Incorrect PIN.' : error?.message || 'Could not unlock.');
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  return (
    <View style={styles.card} testID="vault-unlock">
      <Icon name="lock" size={36} color={accentStyle.color} />
      <Text style={typography.heading}>{title}</Text>
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
      {enrollable && (
        <View style={styles.remember}>
          <Text style={[typography.caption, styles.rememberLabel]}>Use biometrics next time</Text>
          <StarSwitch
            value={remember}
            onValueChange={setRemember}
            disabled={busy}
            accessibilityLabel="Use biometrics next time"
            testID="vault-remember-biometrics"
          />
        </View>
      )}
      <View style={styles.actions}>
        <PrimaryButton title="Unlock" onPress={submit} disabled={!pin || wait > 0} loading={busy} />
        {enrolled && (
          <PrimaryButton title="Use biometrics" variant="secondary" onPress={tryBiometrics} disabled={busy || wait > 0} />
        )}
      </View>
      {onForgot && (
        <Pressable
          onPress={onForgot}
          accessibilityRole="button"
          hitSlop={12}
          testID="vault-forgot"
          style={styles.forgot}>
          <Text style={[typography.caption, accentStyle.text]}>Forgot your PIN?</Text>
        </Pressable>
      )}
      {offerBiometrics && enrolled && (
        <Pressable
          onPress={stopBiometrics}
          disabled={busy}
          accessibilityRole="button"
          hitSlop={12}
          testID="vault-stop-biometrics"
          style={styles.forgot}>
          <Text style={[typography.caption, styles.center]}>Stop using biometrics on this phone</Text>
        </Pressable>
      )}
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
  remember: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
  },
  rememberLabel: {flex: 1},
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
