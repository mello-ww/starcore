import React, {useState} from 'react';
import {StyleSheet, Switch, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

export function SettingsScreen() {
  const {
    logout,
    biometricsAvailable,
    biometricUnlockEnabled,
    enableBiometricUnlock,
    disableBiometricUnlock,
  } = useAuth();
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
});
