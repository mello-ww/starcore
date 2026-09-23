import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {Card} from '../../components/Card';
import {PrimaryButton} from '../../components/PrimaryButton';
import {Starfield} from '../../components/Starfield';
import type {OnboardingStackParamList} from '../../navigation/OnboardingNavigator';
import {normalizeServerUrl, testConnection} from '../../servers/testConnection';
import {colors, spacing, typography} from '../../theme';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'ServerAddress'> & {
  onConnect: (name: string, url: string) => void;
};

/**
 * Second (and, for now, last) onboarding step - see "Fix the first-launch
 * onboarding navigation" in the task brief. The back button here (and
 * Android's hardware back, handled automatically by the enclosing
 * NavigationContainer/NativeStackNavigator - see OnboardingNavigator) both
 * just pop back to ServerNameStep, which is still mounted underneath with
 * whatever the user already typed there.
 *
 * Unlike the original single-screen ConnectScreen, this never calls
 * `onConnect` on address shape alone - it actually reaches the server
 * first (testConnection) and shows a clear error instead of silently
 * treating a wrong or unreachable address as connected.
 */
export function ServerAddressStep({navigation, route, onConnect}: Props) {
  const [url, setUrl] = useState(route.params?.address ?? '');
  const [touched, setTouched] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = url.trim();
  const looksValid = trimmed.length > 0;

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    const normalized = normalizeServerUrl(trimmed);
    const result = await testConnection(normalized);
    setConnecting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onConnect(route.params.name, normalized);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Starfield />
      <View style={styles.content}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12} testID="onboarding-back-button">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>

        <Text style={typography.title}>Connect to StarCore</Text>
        <Text style={[typography.caption, styles.subtitle]}>
          Enter the address of your own StarCore server - the same one Mission Control opens in
          a browser.
        </Text>

        <Card style={styles.card}>
          <Text style={typography.label}>SERVER ADDRESS</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            onBlur={() => setTouched(true)}
            placeholder="192.168.1.20:8090"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!connecting}
            testID="onboarding-address-input"
          />
          {touched && trimmed.length === 0 && <Text style={styles.error}>Enter a server address.</Text>}
          {error && <Text style={styles.error}>{error}</Text>}
        </Card>

        <PrimaryButton
          title="Connect"
          disabled={!looksValid}
          loading={connecting}
          onPress={handleConnect}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md},
  subtitle: {marginBottom: spacing.md},
  card: {gap: spacing.xs, marginBottom: spacing.lg},
  input: {color: colors.text, fontSize: 16, paddingVertical: spacing.sm},
  error: {color: colors.alert, fontSize: 13},
  back: {color: colors.azure, fontSize: 16, marginBottom: spacing.sm},
});
