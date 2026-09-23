import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

/**
 * The very first screen: where is *your* StarCore? There is no default and
 * no hardcoded address here on purpose - see "Do not put ... server-specific
 * paths ... into the mobile source code" in the task brief, and src/config.ts.
 * A plain HTTP address is accepted (a LAN-only StarCore, `http://` by
 * default per docs/deployment.md) as well as HTTPS.
 */
export function ConnectScreen({onConnect}: {onConnect: (url: string) => void}) {
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmed = url.trim();
  const looksValid = /^https?:\/\/.+/i.test(trimmed);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Starfield />
      <View style={styles.content}>
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
            placeholder="https://192.168.1.20:8090"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="connect-url-input"
          />
          {touched && trimmed.length > 0 && !looksValid && (
            <Text style={styles.error}>Include http:// or https://</Text>
          )}
        </Card>

        <PrimaryButton
          title="Continue"
          disabled={!looksValid}
          onPress={() => onConnect(trimmed)}
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
  error: {color: colors.alert, fontSize: 13},
});
