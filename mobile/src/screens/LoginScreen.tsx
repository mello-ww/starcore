import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

export function LoginScreen() {
  const {login, loginError} = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch {
      // loginError (from AuthContext) already reflects this - nothing
      // further to do here besides letting the button re-enable
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Starfield />
      <View style={styles.content}>
        <Text style={typography.title}>StarCore</Text>
        <Text style={[typography.caption, styles.subtitle]}>Sign in with your StarCore account.</Text>

        <Card style={styles.card}>
          <Text style={typography.label}>USERNAME</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            testID="login-username-input"
          />
          <View style={styles.divider} />
          <Text style={typography.label}>PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            testID="login-password-input"
          />
        </Card>

        {loginError ? <Text style={styles.error}>{loginError}</Text> : null}

        <PrimaryButton title="Log in" onPress={submit} disabled={!canSubmit} loading={submitting} />
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
  divider: {height: 1, backgroundColor: colors.line, marginVertical: spacing.xs},
  error: {color: colors.alert, fontSize: 13, marginBottom: spacing.sm},
});
