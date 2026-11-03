import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {Button} from '../components/Button';
import {ScreenTitle} from '../components/ScreenTitle';
import {Surface} from '../components/Surface';
import {fonts, tokens, useTopInset} from '../theme';

const {palette, radii, space, type} = tokens;

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
  const top = useTopInset();
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
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, {paddingTop: top + space.xl}]}>
      <ScreenTitle eyebrow="StarCore" title="Config" subtitle="Configuration of this StarCore server." developerToggle />
      {error && <Text style={styles.error}>{error}</Text>}
      {(settings ?? []).map(setting => (
        <Surface key={setting.path} style={styles.card}>
          <Text style={type.eyebrow}>{setting.path.toUpperCase()}</Text>
          <Text style={type.body}>{setting.description}</Text>
          <TextInput
            style={styles.input}
            value={drafts[setting.path] ?? String(setting.value)}
            onChangeText={value => setDrafts(previous => ({...previous, [setting.path]: value}))}
            placeholderTextColor={palette.text3}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {setting.pending_restart && (
            <Text style={styles.pending}>Saved value differs from what's running - restart to apply.</Text>
          )}
          <Button
            title="Save"
            variant="secondary"
            style={styles.save}
            onPress={() => save(setting)}
            disabled={savingKey === setting.path || drafts[setting.path] === undefined}
            loading={savingKey === setting.path}
          />
        </Surface>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md},
  card: {gap: space.md},
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    backgroundColor: palette.field,
    color: palette.text,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  pending: {color: palette.warn, fontSize: 13},
  save: {alignSelf: 'flex-start'},
  error: {color: palette.danger, fontSize: 13},
});
