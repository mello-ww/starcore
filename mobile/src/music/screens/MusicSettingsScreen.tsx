import React from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {ScreenTitle} from '../../components/ScreenTitle';
import {StarSwitch} from '../../components/StarSwitch';
import {useDeveloperMode} from '../../developer/DeveloperModeContext';
import {Surface} from '../../components/Surface';
import {tokens, TOUCH_TARGET, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {MusicPreferences} from '../types';
import {useMusicNavigation} from '../ui/navigation';

const {palette, radii, space, type} = tokens;

type Option = {value: string; label: string};

const QUALITY: Option[] = [
  {value: 'original', label: 'Original'},
  {value: 'high', label: 'High'},
  {value: 'normal', label: 'Normal'},
  {value: 'low', label: 'Low'},
];
const FORMAT: Option[] = [
  {value: 'opus', label: 'Opus'},
  {value: 'aac', label: 'AAC'},
  {value: 'mp3', label: 'MP3'},
];
const REPLAYGAIN: Option[] = [
  {value: 'off', label: 'Off'},
  {value: 'track', label: 'Track'},
  {value: 'album', label: 'Album'},
];
const QUEUE_END: Option[] = [
  {value: 'stop', label: 'Stop'},
  {value: 'repeat', label: 'Repeat'},
  {value: 'autoplay', label: 'Autoplay'},
];
const SPEED: Option[] = ['0.75', '1', '1.25', '1.5'].map(value => ({value, label: `${value}×`}));
const PITCH: Option[] = ['-2', '-1', '0', '1', '2'].map(value => ({value, label: Number(value) > 0 ? `+${value}` : value}));
const NETWORK: Option[] = [
  {value: 'wifi', label: 'Wi-Fi only'},
  {value: 'any', label: 'Any network'},
];
const STORAGE: Option[] = [
  {value: '1024', label: '1 GB'},
  {value: '2048', label: '2 GB'},
  {value: '8192', label: '8 GB'},
  {value: '32768', label: '32 GB'},
];

/** A titled group of settings on one card, rows separated by hairlines. */
function Group({title, note, children}: {title: string; note?: string; children: React.ReactNode}) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title.toUpperCase()}</Text>
      <Surface style={styles.card}>
        {rows.map((row, index) => (
          <View key={index} style={index > 0 && styles.divided}>
            {row}
          </View>
        ))}
      </Surface>
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

function Choice({label, value, options, onChange}: {label: string; value: string; options: Option[]; onChange: (value: string) => void}) {
  const accentStyle = useAccentStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map(option => {
          const selected = value === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{selected}}
              accessibilityLabel={`${label}: ${option.label}`}
              hitSlop={4}
              style={[styles.option, selected && accentStyle.fill]}>
              <Text style={[styles.optionLabel, selected && [styles.optionLabelSelected, accentStyle.onFill]]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Toggle({label, value, onChange, hint}: {label: string; value: boolean; onChange: (value: boolean) => void; hint?: string}) {
  return (
    <View style={[styles.row, styles.inline]}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={type.caption}>{hint}</Text> : null}
      </View>
      <StarSwitch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

function Link({icon, label, onPress, danger}: {icon: string; label: string; onPress: () => void; danger?: boolean}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({pressed}) => [styles.row, styles.inline, styles.link, pressed && styles.pressed]}>
      <Icon name={icon} size={20} color={danger ? palette.danger : palette.textIcon} />
      <Text style={[styles.label, styles.text, danger && styles.danger]}>{label}</Text>
      {danger ? null : <Icon name="chevron-right" size={20} color={palette.text3} />}
    </Pressable>
  );
}

export function MusicSettingsScreen() {
  const accentStyle = useAccentStyles();
  const {preferences, updatePreferences, api, downloads} = useMusic();
  const {enabled: developer} = useDeveloperMode(); // transcode format is an advanced setting
  const go = useMusicNavigation();
  if (!preferences) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={accentStyle.color} style={styles.loading} />
      </View>
    );
  }
  const set = (changes: Partial<MusicPreferences>) =>
    updatePreferences(changes).catch((error: any) => Alert.alert('Music settings', error?.message ?? 'Could not save.'));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ScreenTitle eyebrow="Music" title="Settings" subtitle="Playback and downloads for this device." />

      <Group title="Streaming" note="Anything but Original needs FFmpeg on the server; without it the original file is streamed.">
        <Choice label="Wi-Fi quality" value={preferences.streaming_quality} options={QUALITY} onChange={value => set({streaming_quality: value as any})} />
        <Choice label="Cellular quality" value={preferences.cellular_quality} options={QUALITY} onChange={value => set({cellular_quality: value as any})} />
        {developer && (
          <Choice label="Transcode format" value={preferences.transcode_format} options={FORMAT} onChange={value => set({transcode_format: value as any})} />
        )}
      </Group>

      <Group title="Playback" note="Crossfade and gapless playback are not available on Android yet; tracks play back to back.">
        <Choice label="ReplayGain" value={preferences.replaygain} options={REPLAYGAIN} onChange={value => set({replaygain: value as any})} />
        <Choice label="When the queue ends" value={preferences.queue_end} options={QUEUE_END} onChange={value => set({queue_end: value as any})} />
        <Choice label="Speed" value={String(preferences.speed)} options={SPEED} onChange={value => set({speed: Number(value)})} />
        <Choice label="Pitch (semitones)" value={String(preferences.pitch)} options={PITCH} onChange={value => set({pitch: Number(value)})} />
        <Toggle label="Keep pitch when changing speed" value={preferences.preserve_pitch} onChange={value => set({preserve_pitch: value})} />
        <Link icon="sliders" label="Equalizer and bass boost" onPress={go.equalizer} />
      </Group>

      <Group title="Downloads">
        <Choice label="Download quality" value={preferences.download_quality} options={QUALITY} onChange={value => set({download_quality: value as any})} />
        <Choice label="Download over" value={preferences.download_network} options={NETWORK} onChange={value => set({download_network: value as any})} />
        <Choice
          label="Storage limit"
          value={String(preferences.cache_limit_mb)}
          options={STORAGE}
          onChange={value => set({cache_limit_mb: Number(value)}).then(() => downloads.enforceLimit())}
        />
        <Link icon="download" label="Manage downloads" onPress={go.downloads} />
      </Group>

      <Group title="Privacy">
        <Toggle
          label="Listening history"
          hint="Used for Home, mixes, stats and Wrapped - kept on your server only."
          value={preferences.history_enabled}
          onChange={value => set({history_enabled: value})}
        />
        <Toggle label="Recommendations" value={preferences.discovery_enabled} onChange={value => set({discovery_enabled: value})} />
        <Link
          icon="trash-2"
          label="Clear listening history"
          danger
          onPress={() =>
            Alert.alert('Clear history', 'Remove your whole listening history?', [
              {text: 'Cancel', style: 'cancel'},
              {text: 'Clear', style: 'destructive', onPress: () => api.clearHistory().catch(() => undefined)},
            ])
          }
        />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  // the mini-player and tab bar sit over the bottom of every Music screen
  content: {paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 140, gap: space.xl},
  loading: {marginTop: space.xxl},
  group: {gap: space.sm},
  groupTitle: {...type.eyebrow, marginLeft: space.xs},
  card: {paddingVertical: 0},
  divided: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.controlStrong},
  note: {...type.caption, color: palette.text3, marginHorizontal: space.xs},
  row: {minHeight: TOUCH_TARGET + 8, paddingVertical: space.md, gap: space.sm, justifyContent: 'center'},
  inline: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  text: {flex: 1, gap: space.xs},
  label: {...type.label},
  link: {paddingVertical: space.sm},
  pressed: {opacity: 0.7},
  danger: {color: palette.danger},
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  option: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: palette.controlStrong,
    backgroundColor: palette.control,
    justifyContent: 'center',
  },
  optionLabel: {color: palette.text2, fontSize: 14, fontWeight: '600'},
  optionLabelSelected: {color: palette.onAccent, fontWeight: '700'},
});
