import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';
import type {SettingsStackParamList} from '../navigation/MainTabs';

type Props = NativeStackScreenProps<SettingsStackParamList, 'SettingsHome'>;

const NOT_ENROLLED_MESSAGE = 'No fingerprint is enrolled on this device. Add one in Android Settings first.';

const TOGGLE_MESSAGES: Record<string, string> = {
  'not-enrolled': NOT_ENROLLED_MESSAGE,
  unavailable: 'Biometric authentication is not available on this device right now.',
  failed: 'Could not save the biometric unlock setting. Please try again.',
};

/**
 * "Settings" tab: configuration of *this mobile app* - kept strictly
 * separate from "Config" (the remote StarCore server's own settings, see
 * ConfigScreen). Server management lives here for the same reason: which
 * servers this device knows about, and which one is active, is a property
 * of the app, not of any server.
 */
export function SettingsScreen({navigation}: Props) {
  const {
    logout,
    biometricsAvailable,
    biometricsUnavailableReason,
    biometricUnlockEnabled,
    passwordRecoveryAvailable,
    enableBiometricUnlock,
    disableBiometricUnlock,
  } = useAuth();
  const {activeServer} = useServers();
  const [busy, setBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);

  const toggleBiometrics = async (next: boolean) => {
    setBusy(true);
    setBioError(null);
    try {
      // the Switch is controlled by biometricUnlockEnabled, so it only moves
      // once the change has been authenticated and stored
      const result = next ? await enableBiometricUnlock() : await disableBiometricUnlock();
      setBioError(TOGGLE_MESSAGES[result as string] ?? null);
    } catch (err: any) {
      // enableBiometricUnlock/disableBiometricUnlock are documented to
      // resolve rather than reject for every expected outcome (cancelled
      // prompt, Keystore write failure) - this only guards against
      // something genuinely unexpected, so the Switch's fire-and-forget
      // handler can never produce an unhandled promise rejection.
      setBioError(err?.message || 'Something went wrong with biometric unlock.');
    } finally {
      setBusy(false);
    }
  };

  const notEnrolled = !biometricsAvailable && biometricsUnavailableReason === 'not-enrolled';
  // still shown when biometrics went away after enabling, so it can be seen as on
  const showBiometricCard = biometricsAvailable || notEnrolled || biometricUnlockEnabled;

  return (
    <View style={styles.screen}>
      <Starfield count={20} />
      <View style={styles.content}>
        <Text style={typography.title}>Settings</Text>

        <Pressable onPress={() => navigation.navigate('Servers')}>
          <Card style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={typography.heading}>Servers</Text>
                <Text style={[typography.caption, styles.caption]}>
                  {activeServer ? `Connected to ${activeServer.name}` : 'No server selected'} - manage or add servers
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Pressable>

        {showBiometricCard && (
          <Card style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={typography.heading}>Biometric unlock</Text>
                <Text style={[typography.caption, styles.caption]}>
                  Require your fingerprint to open StarCore for this server, on this device only.
                </Text>
              </View>
              <Switch
                value={biometricUnlockEnabled}
                onValueChange={toggleBiometrics}
                disabled={busy || (!biometricsAvailable && !passwordRecoveryAvailable)}
                testID="biometric-unlock-switch"
              />
            </View>
            {bioError ? (
              <Text style={styles.error}>{bioError}</Text>
            ) : passwordRecoveryAvailable ? (
              <Text style={[typography.caption, styles.caption]}>
                Biometrics aren't available, but you just signed in with your password, so you can turn this off.
              </Text>
            ) : notEnrolled ? (
              <Text style={[typography.caption, styles.caption]}>{NOT_ENROLLED_MESSAGE}</Text>
            ) : null}
          </Card>
        )}

        <PrimaryButton title="Log out" variant="secondary" onPress={() => logout()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  card: {},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  rowText: {flex: 1, gap: spacing.xs},
  caption: {},
  chevron: {color: colors.textFaint, fontSize: 20},
  error: {color: colors.alert, fontSize: 13},
});
