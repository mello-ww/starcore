import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {Starfield} from '../components/Starfield';
import {normalizeServerUrl, testConnection} from '../servers/testConnection';
import {colors, spacing, typography} from '../theme';

/**
 * Where is *your* StarCore? There is no default and no hardcoded address
 * here on purpose - see "Do not put ... server-specific paths ... into the
 * mobile source code" in the task brief, and src/config.ts. An address
 * with or without `http://`/`https://` is accepted (see
 * src/servers/testConnection.ts) - a LAN-only StarCore is plain HTTP by
 * default per docs/deployment.md.
 *
 * Used two ways: as the second step of first-run onboarding (see
 * navigation/OnboardingNavigator.tsx, which now handles that case as its
 * own two-step wizard - this component is the "add another server" path
 * only), passing `onBack`, and by ServersGate before any server has ever
 * been added, in which case `onBack` is intentionally omitted.
 */
export function ConnectScreen({
  onConnect,
  onBack,
}: {
  onConnect: (name: string, url: string) => void;
  onBack?: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
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
    onConnect(name, normalized);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Starfield />
      <View style={styles.content}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={12} testID="connect-back-button">
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={typography.title}>Connect to StarCore</Text>
        <Text style={[typography.caption, styles.subtitle]}>
          Enter the address of your own StarCore server - the same one Mission Control opens in
          a browser.
        </Text>

        <Card style={styles.card}>
          <Text style={typography.label}>NAME (OPTIONAL)</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Home"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="words"
            testID="connect-name-input"
          />
          <View style={styles.divider} />
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
            testID="connect-url-input"
          />
          {touched && trimmed.length === 0 && <Text style={styles.error}>Enter a server address.</Text>}
          {error && <Text style={styles.error}>{error}</Text>}
        </Card>

        <PrimaryButton
          title="Continue"
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
  input: {
    color: colors.text,
    fontSize: 16,
    paddingVertical: spacing.sm,
  },
  divider: {height: 1, backgroundColor: colors.line, marginVertical: spacing.xs},
  error: {color: colors.alert, fontSize: 13},
  back: {color: colors.azure, fontSize: 16, marginBottom: spacing.sm},
});
