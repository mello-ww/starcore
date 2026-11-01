import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {StarSwitch} from '../components/StarSwitch';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {Button} from '../components/Button';
import {ScreenTitle} from '../components/ScreenTitle';
import {Surface} from '../components/Surface';
import {tokens, useAccent, useTopInset} from '../theme';
import type {SettingsStackParamList} from '../navigation/MainTabs';

const {palette, space, type} = tokens;

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
  const {color: accent} = useAccent();
  const top = useTopInset();
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
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, {paddingTop: top + space.xl}]}>
      <ScreenTitle eyebrow="StarCore" title="Settings" subtitle="Preferences for this app on this device." />

      <Pressable
        onPress={() => navigation.navigate('Servers')}
        accessibilityRole="button"
        style={({pressed}) => pressed && styles.pressed}>
        <Surface>
          <View style={styles.row}>
            <Icon name="server" size={20} color={accent} />
            <View style={styles.rowText}>
              <Text style={type.title}>Servers</Text>
              <Text style={type.caption}>
                {activeServer ? `Connected to ${activeServer.name}` : 'No server selected'} - manage or add servers
              </Text>
            </View>
            <Icon name="chevron-right" size={20} color={palette.text3} />
          </View>
        </Surface>
      </Pressable>

      {showBiometricCard && (
        <Surface style={styles.card}>
          <View style={styles.row}>
            <Icon name="lock" size={20} color={accent} />
            <View style={styles.rowText}>
              <Text style={type.title}>Biometric unlock</Text>
              <Text style={type.caption}>
                Require your fingerprint to open StarCore for this server, on this device only.
              </Text>
            </View>
            <StarSwitch
              value={biometricUnlockEnabled}
              onValueChange={toggleBiometrics}
              disabled={busy || (!biometricsAvailable && !passwordRecoveryAvailable)}
              testID="biometric-unlock-switch"
            />
          </View>
          {bioError ? (
            <Text style={styles.error}>{bioError}</Text>
          ) : passwordRecoveryAvailable ? (
            <Text style={type.caption}>
              Biometrics aren't available, but you just signed in with your password, so you can turn this off.
            </Text>
          ) : notEnrolled ? (
            <Text style={type.caption}>{NOT_ENROLLED_MESSAGE}</Text>
          ) : null}
        </Surface>
      )}

      <Button title="Log out" variant="secondary" onPress={() => logout()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md},
  card: {gap: space.md},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  rowText: {flex: 1, gap: space.xs},
  error: {color: palette.danger, fontSize: 13},
  pressed: {opacity: 0.85},
});
