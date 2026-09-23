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
    biometricUnlockEnabled,
    enableBiometricUnlock,
    disableBiometricUnlock,
  } = useAuth();
  const {activeServer} = useServers();
  const [busy, setBusy] = useState(false);

  const toggleBiometrics = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        await enableBiometricUnlock();
      } else {
        await disableBiometricUnlock();
      }
    } finally {
      setBusy(false);
    }
  };

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

        {biometricsAvailable && (
          <Card style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={typography.heading}>Biometric unlock</Text>
                <Text style={[typography.caption, styles.caption]}>
                  Use your fingerprint or face to sign back in, instead of your password, on this
                  device only.
                </Text>
              </View>
              <Switch
                value={biometricUnlockEnabled}
                onValueChange={toggleBiometrics}
                disabled={busy}
                testID="biometric-unlock-switch"
              />
            </View>
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
});
