import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import {colors, spacing, typography} from '../theme';
import {configureBackgroundFetch, runBackgroundSync} from './backgroundSyncTask';
import {requestMediaLibraryPermission} from './mediaPermission';
import {getSyncState, setSyncEnabled, setWifiOnly} from './syncState';
import {usePhotoApi} from './usePhotoApi';

/**
 * Settings for this server's automatic phone sync - see "Real automatic
 * phone sync" in docs/satellites/photo.md. Turning it on requests the
 * camera-roll permission right here, in the foreground, where Android can
 * actually show the prompt (the background/periodic path never prompts -
 * see mediaPermission.ts). "Sync now" runs the exact same pass the periodic
 * tick and the on-open trigger both use (runBackgroundSync), so this is
 * never a second sync implementation, just a manual way to trigger the one
 * there is.
 *
 * Never deletes anything from the phone - this only ever sends copies
 * onward, exactly like the manual upload page sync.py itself still serves
 * for a browser.
 */
export function PhotoSyncTab() {
  const {serverId} = usePhotoApi();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [wifiOnly, setWifiOnlyState] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const state = await getSyncState(serverId);
    setEnabled(state.enabled);
    setWifiOnlyState(state.wifiOnly);
    setLoaded(true);
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const onToggleEnabled = async (value: boolean) => {
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
    setEnabled(value);
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
    setLastResult(null);
    try {
      await runBackgroundSync();
      setLastResult('Sync finished.');
    } catch (err: any) {
      setLastResult(null);
      Alert.alert('Sync could not finish', err?.message || 'Please try again.');
    } finally {
      setSyncing(false);
    }
  };

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.azure} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={typography.body}>Automatic sync</Text>
          <Text style={[typography.caption, styles.hint]}>
            New photos and videos on this phone are uploaded to this StarCore server in the
            background, roughly every 15 minutes, and whenever you open this app. Nothing is ever
            deleted from your phone.
          </Text>
        </View>
        <Switch value={enabled} onValueChange={onToggleEnabled} />
      </View>

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={typography.body}>Wi-Fi only</Text>
          <Text style={[typography.caption, styles.hint]}>
            Applies to the periodic background check. Opening the app can still sync over cellular.
          </Text>
        </View>
        <Switch value={wifiOnly} onValueChange={onToggleWifiOnly} disabled={!enabled} />
      </View>

      <Pressable
        style={[styles.syncButton, (syncing || !enabled) && styles.syncButtonDisabled]}
        onPress={onSyncNow}
        disabled={syncing || !enabled}>
        {syncing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.syncButtonLabel}>Sync now</Text>}
      </Pressable>

      {lastResult && <Text style={[typography.caption, styles.hint]}>{lastResult}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: spacing.lg, gap: spacing.lg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  rowText: {flex: 1, gap: 2},
  hint: {color: colors.textFaint},
  syncButton: {
    backgroundColor: colors.raised,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.lineBright,
  },
  syncButtonDisabled: {opacity: 0.6},
  syncButtonLabel: {color: colors.text, fontWeight: '600'},
});
