import React from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {colors, radius, spacing, typography} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {MusicPreferences} from '../types';
import {useMusicNavigation} from '../ui/navigation';

const QUALITY = ['original', 'high', 'normal', 'low'];

function Choice({label, value, options, onChange}: {label: string; value: string; options: string[]; onChange: (value: string) => void}) {
  return (
    <View style={styles.setting}>
      <Text style={typography.body}>{label}</Text>
      <View style={styles.options}>
        {options.map(option => (
          <Pressable key={option} onPress={() => onChange(option)} style={[styles.option, value === option && styles.optionActive]}>
            <Text style={styles.optionLabel}>{option}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Toggle({label, value, onChange, hint}: {label: string; value: boolean; onChange: (value: boolean) => void; hint?: string}) {
  return (
    <View style={[styles.setting, styles.toggle]}>
      <View style={styles.toggleText}>
        <Text style={typography.body}>{label}</Text>
        {hint && <Text style={typography.caption}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

export function MusicSettingsScreen() {
  const {preferences, updatePreferences, api, downloads} = useMusic();
  const go = useMusicNavigation();
  if (!preferences) {
    return <ActivityIndicator color={colors.azure} style={styles.loading} />;
  }
  const set = (changes: Partial<MusicPreferences>) =>
    updatePreferences(changes).catch((error: any) => Alert.alert('Music settings', error?.message ?? 'Could not save.'));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={typography.heading}>Streaming</Text>
      <Choice label="Wi-Fi quality" value={preferences.streaming_quality} options={QUALITY} onChange={value => set({streaming_quality: value as any})} />
      <Choice label="Cellular quality" value={preferences.cellular_quality} options={QUALITY} onChange={value => set({cellular_quality: value as any})} />
      <Choice label="Transcode format" value={preferences.transcode_format} options={['opus', 'aac', 'mp3']}
        onChange={value => set({transcode_format: value as any})} />
      <Text style={typography.caption}>Anything but original needs FFmpeg on the server; without it the original file is streamed.</Text>

      <Text style={[typography.heading, styles.heading]}>Playback</Text>
      <Choice label="ReplayGain" value={preferences.replaygain} options={['off', 'track', 'album']} onChange={value => set({replaygain: value as any})} />
      <Choice label="When the queue ends" value={preferences.queue_end} options={['stop', 'repeat', 'autoplay']}
        onChange={value => set({queue_end: value as any})} />
      <Choice label="Speed" value={String(preferences.speed)} options={['0.75', '1', '1.25', '1.5']} onChange={value => set({speed: Number(value)})} />
      <Choice label="Pitch (semitones)" value={String(preferences.pitch)} options={['-2', '-1', '0', '1', '2']} onChange={value => set({pitch: Number(value)})} />
      <Toggle label="Keep pitch when changing speed" value={preferences.preserve_pitch} onChange={value => set({preserve_pitch: value})} />
      <Pressable onPress={go.equalizer} style={styles.row}><Text style={typography.body}>Equalizer and bass boost ›</Text></Pressable>
      <Text style={typography.caption}>Crossfade and gapless playback are not available on Android yet; tracks play back to back.</Text>

      <Text style={[typography.heading, styles.heading]}>Downloads</Text>
      <Choice label="Download quality" value={preferences.download_quality} options={QUALITY} onChange={value => set({download_quality: value as any})} />
      <Choice label="Download over" value={preferences.download_network} options={['wifi', 'any']} onChange={value => set({download_network: value as any})} />
      <Choice label="Storage limit (MB)" value={String(preferences.cache_limit_mb)} options={['1024', '2048', '8192', '32768']}
        onChange={value => set({cache_limit_mb: Number(value)}).then(() => downloads.enforceLimit())} />
      <Pressable onPress={go.downloads} style={styles.row}><Text style={typography.body}>Manage downloads ›</Text></Pressable>

      <Text style={[typography.heading, styles.heading]}>Privacy</Text>
      <Toggle label="Listening history" hint="Used for Home, mixes, stats and Wrapped - kept on your server only"
        value={preferences.history_enabled} onChange={value => set({history_enabled: value})} />
      <Toggle label="Recommendations" value={preferences.discovery_enabled} onChange={value => set({discovery_enabled: value})} />
      <Pressable style={styles.row} onPress={() => Alert.alert('Clear history', 'Remove your whole listening history?', [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Clear', style: 'destructive', onPress: () => api.clearHistory().catch(() => undefined)},
      ])}>
        <Text style={styles.danger}>Clear listening history</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void, gap: spacing.sm},
  loading: {marginTop: spacing.xl},
  heading: {marginTop: spacing.lg},
  setting: {gap: spacing.xs, paddingVertical: spacing.xs},
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  option: {paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineBright},
  optionActive: {backgroundColor: colors.royal, borderColor: colors.royal},
  optionLabel: {color: colors.text, fontSize: 13},
  toggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  toggleText: {flex: 1, paddingRight: spacing.md},
  row: {paddingVertical: spacing.md},
  danger: {color: colors.alert},
});
