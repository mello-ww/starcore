import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {StarSwitch} from '../components/StarSwitch';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {colors, radius, spacing, typography, useAccentStyles} from '../theme';
import {configureBackgroundFetch, runBackgroundSync} from './backgroundSyncTask';
import {requestMediaLibraryPermission} from './mediaPermission';
import {getSyncState, setSyncEnabled, setWifiOnly} from './syncState';
import type {ConfigurationSetting, SourcePathMapping} from './types';
import {usePhotoApi} from './usePhotoApi';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

/** Whether Photo describes this setting as advanced (shown in Developer Mode only). */
function isDeveloperSetting(settings: ConfigurationSetting[] | null, key: string): boolean {
  return Boolean(settings?.find(setting => setting.key === key)?.developer);
}

function settingValue<T>(settings: ConfigurationSetting[], key: string, fallback: T): T {
  const setting = settings.find(item => item.key === key);
  return setting ? (setting.value as T) : fallback;
}

/**
 * Everything Photo-specific in one place, reached from a settings entry
 * rather than its own bottom-tab segment (per "Photo configuration...
 * reachable via a settings entry" in the task brief): the phone -> server
 * path mappings physical albums are built from, the default sync
 * destination, the recycle bin's retention period, and this server's own
 * automatic phone sync (moved in from the old standalone "Sync" tab - see
 * docs/satellites/photo.md, "Mobile app"). Every setting here goes through
 * the same generic /configuration route the web panel's own Configuration
 * tab uses (see configuration.py) - there is no second settings mechanism.
 */
export function PhotoConfigurationScreen() {
  const accentStyle = useAccentStyles();
  const {api, serverId} = usePhotoApi();
  const {enabled: developer} = useDeveloperMode();
  const [settings, setSettings] = useState<ConfigurationSetting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<SourcePathMapping[]>([]);
  const [savingMappings, setSavingMappings] = useState(false);
  const [defaultPath, setDefaultPath] = useState('');
  const [retentionDays, setRetentionDays] = useState('');

  const [syncLoaded, setSyncLoaded] = useState(false);
  const [syncEnabled, setSyncEnabledState] = useState(false);
  const [wifiOnly, setWifiOnlyState] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.configuration();
      setSettings(payload.settings);
      setMappings(settingValue<SourcePathMapping[]>(payload.settings, 'source_paths', []).map(entry => ({...entry})));
      setDefaultPath(settingValue(payload.settings, 'sync_default_path', ''));
      setRetentionDays(String(settingValue(payload.settings, 'trash_retention_days', '')));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load configuration.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const state = await getSyncState(serverId);
      setSyncEnabledState(state.enabled);
      setWifiOnlyState(state.wifiOnly);
      setSyncLoaded(true);
    })();
  }, [serverId]);

  const saveMappings = async () => {
    setSavingMappings(true);
    try {
      await api.updateConfiguration('source_paths', mappings);
      await load();
    } catch (err: any) {
      Alert.alert('Could not save these mappings', err?.message || 'Please try again.');
    } finally {
      setSavingMappings(false);
    }
  };

  const saveDefaultPath = async () => {
    try {
      await api.updateConfiguration('sync_default_path', defaultPath);
    } catch (err: any) {
      Alert.alert('Could not save', err?.message || 'Please try again.');
    }
  };

  const saveRetention = async () => {
    try {
      await api.updateConfiguration('trash_retention_days', Number(retentionDays));
    } catch (err: any) {
      Alert.alert('Could not save', err?.message || 'Please try again.');
    }
  };

  const updateMapping = (index: number, field: keyof SourcePathMapping, value: string) => {
    setMappings(current => current.map((entry, position) => (position === index ? {...entry, [field]: value} : entry)));
  };

  const removeMapping = (index: number) => {
    setMappings(current => current.filter((_, position) => position !== index));
  };

  const addMapping = () => {
    setMappings(current => [...current, {phone_path: '', server_path: '', name: ''}]);
  };

  const onToggleSyncEnabled = async (value: boolean) => {
    if (value) {
      const granted = await requestMediaLibraryPermission();
      if (!granted) {
        Alert.alert(
          'Permission needed',
          'StarCore needs access to your photos and videos to sync them automatically. ' +
            'You can grant this later from your phone’s app settings.',
        );
        return;
      }
    }
    setSyncEnabledState(value);
    await setSyncEnabled(serverId, value);
    await configureBackgroundFetch();
  };

  const onToggleWifiOnly = async (value: boolean) => {
    setWifiOnlyState(value);
    await setWifiOnly(serverId, value);
    await configureBackgroundFetch();
  };

  const onSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      await runBackgroundSync();
      setSyncResult('Sync finished.');
    } catch (err: any) {
      Alert.alert('Sync could not finish', err?.message || 'Please try again.');
    } finally {
      setSyncing(false);
    }
  };

  if (error && !settings) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!settings || !syncLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={accentStyle.color} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Section title="Phone folder → server path mappings">
        <Text style={[typography.caption, styles.hint]}>
          Each mapping becomes its own physical album (see the Albums tab). The phone folder is whatever your
          phone's own camera-roll grouping calls it; the server path is never assumed to be the same string.
        </Text>
        {mappings.map((entry, index) => (
          <View key={entry.id ?? index} style={styles.mappingRow}>
            <LabeledInput
              label="Phone folder"
              value={entry.phone_path}
              placeholder="/Pictures/Screenshots"
              onChangeText={value => updateMapping(index, 'phone_path', value)}
            />
            <LabeledInput
              label="Server path"
              value={entry.server_path}
              placeholder="screenshots"
              onChangeText={value => updateMapping(index, 'server_path', value)}
            />
            <LabeledInput
              label="Album name"
              value={entry.name || ''}
              placeholder="Screenshots"
              onChangeText={value => updateMapping(index, 'name', value)}
            />
            <Pressable onPress={() => removeMapping(index)} hitSlop={8} style={styles.removeMapping}>
              <Text style={styles.removeMappingLabel}>Remove mapping</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.mappingActions}>
          <Pressable onPress={addMapping} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonLabel}>Add mapping</Text>
          </Pressable>
          <Pressable onPress={saveMappings} disabled={savingMappings} style={[styles.primaryButton, accentStyle.border]}>
            <Text style={styles.primaryButtonLabel}>{savingMappings ? 'Saving…' : 'Save mappings'}</Text>
          </Pressable>
        </View>
      </Section>

      <Section title="Other settings">
        {(developer || !isDeveloperSetting(settings, 'sync_default_path')) && (
          <ConfigRow
            label="Default sync destination"
            hint="Physical album a synced file joins when its phone folder matches no mapping above."
            value={defaultPath}
            onChangeText={setDefaultPath}
            onSave={saveDefaultPath}
          />
        )}
        <ConfigRow
          label="Recycle bin retention (days)"
          value={retentionDays}
          onChangeText={setRetentionDays}
          onSave={saveRetention}
          keyboardType="number-pad"
        />
      </Section>

      <Section title="Automatic phone sync">
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={typography.body}>Automatic sync</Text>
            <Text style={[typography.caption, styles.hint]}>
              New photos and videos on this phone are uploaded to this StarCore server in the background, roughly
              every 15 minutes, and whenever you open this app. Nothing is ever deleted from your phone.
            </Text>
          </View>
          <StarSwitch value={syncEnabled} onValueChange={onToggleSyncEnabled} />
        </View>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={typography.body}>Wi-Fi only</Text>
            <Text style={[typography.caption, styles.hint]}>
              Applies to the periodic background check. Opening the app can still sync over cellular.
            </Text>
          </View>
          <StarSwitch value={wifiOnly} onValueChange={onToggleWifiOnly} disabled={!syncEnabled} />
        </View>
        <Pressable
          style={[styles.syncButton, (syncing || !syncEnabled) && styles.syncButtonDisabled]}
          onPress={onSyncNow}
          disabled={syncing || !syncEnabled}>
          {syncing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.syncButtonLabel}>Sync now</Text>}
        </Pressable>
        {syncResult && <Text style={[typography.caption, styles.hint]}>{syncResult}</Text>}
      </Section>
      <FloatingPlayerSpacer />
    </ScrollView>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={[typography.label, styles.sectionTitle]}>{title}</Text>
      {children}
    </View>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={styles.fieldInput}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function ConfigRow({
  label,
  hint,
  value,
  onChangeText,
  onSave,
  keyboardType,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (value: string) => void;
  onSave: () => void;
  keyboardType?: 'default' | 'number-pad';
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await onSave();
      setStatus('Saved.');
    } catch (err: any) {
      setStatus(err?.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.configRow}>
      <Text style={typography.body}>{label}</Text>
      {hint && <Text style={[typography.caption, styles.hint]}>{hint}</Text>}
      <View style={styles.configInputRow}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          style={styles.fieldInput}
          keyboardType={keyboardType}
          placeholderTextColor={colors.textFaint}
        />
        <Pressable onPress={save} disabled={saving} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonLabel}>{saving ? '…' : 'Save'}</Text>
        </Pressable>
      </View>
      {status && <Text style={[typography.caption, styles.hint]}>{status}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {padding: spacing.lg, gap: spacing.xl},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  error: {color: colors.alert, fontSize: 13},
  section: {gap: spacing.md},
  sectionTitle: {textTransform: 'uppercase', letterSpacing: 0.4},
  hint: {color: colors.textFaint},
  mappingRow: {gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised},
  field: {gap: 4},
  fieldLabel: {color: colors.textDim, fontSize: 12},
  fieldInput: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.lineBright,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  removeMapping: {alignSelf: 'flex-start'},
  removeMappingLabel: {color: colors.alert, fontSize: 12, fontWeight: '600'},
  mappingActions: {flexDirection: 'row', gap: spacing.sm},
  secondaryButton: {paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineBright, alignItems: 'center', justifyContent: 'center'},
  secondaryButtonLabel: {color: colors.text, fontWeight: '600'},
  primaryButton: {flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.raised, borderWidth: 1, alignItems: 'center'},
  primaryButtonLabel: {color: colors.text, fontWeight: '700'},
  configRow: {gap: spacing.xs},
  configInputRow: {flexDirection: 'row', gap: spacing.sm, alignItems: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  rowText: {flex: 1, gap: 2},
  syncButton: {
    backgroundColor: colors.raised,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.lineBright,
  },
  syncButtonDisabled: {opacity: 0.6},
  syncButtonLabel: {color: colors.text, fontWeight: '600'},
});
