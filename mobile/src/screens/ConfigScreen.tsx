import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography} from '../theme';

/** Mirrors GET/POST /api/configuration - see docs/api.md. */
interface Setting {
  section: string;
  key: string;
  path: string;
  value: unknown;
  description: string;
  restart_required: boolean;
  live_value: unknown;
  pending_restart: boolean;
}

/**
 * "Config" tab: configuration of the *remote StarCore server* - kept
 * strictly separate from "Settings" (the mobile app's own preferences,
 * see SettingsScreen). Reuses `GET`/`POST /api/configuration` exactly as
 * Mission Control's own Configuration page does.
 */
export function ConfigScreen() {
  const {client} = useAuth();
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {status, body} = await client.get('/api/configuration');
      if (status !== 200) {
        throw new Error('Could not load configuration.');
      }
      setSettings(body.settings as Setting[]);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load configuration.');
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (setting: Setting) => {
    const draft = drafts[setting.path];
    if (draft === undefined) {
      return;
    }
    setSavingKey(setting.path);
    try {
      const {status, body} = await client.post('/api/configuration', {
        section: setting.section,
        key: setting.key,
        value: draft,
      });
      if (status !== 200) {
        throw new Error(body?.error || 'Could not save that setting.');
      }
      setSettings(body.settings as Setting[]);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not save that setting.');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={typography.title}>Config</Text>
      <Text style={typography.caption}>Configuration of this StarCore server.</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {(settings ?? []).map(setting => (
        <Card key={setting.path} style={styles.card}>
          <Text style={typography.label}>{setting.path.toUpperCase()}</Text>
          <Text style={typography.caption}>{setting.description}</Text>
          <TextInput
            style={styles.input}
            value={drafts[setting.path] ?? String(setting.value)}
            onChangeText={value => setDrafts(previous => ({...previous, [setting.path]: value}))}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {setting.pending_restart && (
            <Text style={styles.pending}>Saved value differs from what's running - restart to apply.</Text>
          )}
          <PrimaryButton
            title="Save"
            variant="secondary"
            onPress={() => save(setting)}
            disabled={savingKey === setting.path || drafts[setting.path] === undefined}
            loading={savingKey === setting.path}
          />
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  card: {gap: spacing.xs},
  input: {color: colors.text, fontSize: 15, backgroundColor: colors.raised, borderRadius: 8, padding: spacing.sm},
  pending: {color: colors.ice, fontSize: 12},
  error: {color: colors.alert, fontSize: 13},
});
