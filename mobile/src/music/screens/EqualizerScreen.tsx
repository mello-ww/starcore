import React, {useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {StarSwitch} from '../../components/StarSwitch';
import {colors, radius, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import {audioEffects} from '../native';
import type {Equalizer} from '../types';

export const BANDS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

export const PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  rock: [4, 3, 1, -1, -1, 1, 2, 3, 4, 4],
  electronic: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  acoustic: [3, 2, 1, 1, 2, 2, 3, 3, 2, 1],
  loudness: [5, 3, 0, 0, -1, 0, -1, 0, 3, 5],
};

const STEP = 1;
const LIMIT = 12;

export function EqualizerScreen() {
  const accentStyle = useAccentStyles();
  const {preferences, updatePreferences} = useMusic();
  const [eq, setEq] = useState<Equalizer>(preferences?.equalizer ?? {enabled: false, preset: 'flat', bands: PRESETS.flat, preamp: 0});
  const [bass, setBass] = useState(preferences?.bass_boost ?? 0);
  const [status, setStatus] = useState<string | null>(null);
  const save = useRef(updatePreferences);
  save.current = updatePreferences;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      audioEffects.setEqualizer(eq.enabled, eq.bands, eq.preamp).then(result =>
        setStatus(result.applied ? null : result.reason === 'no-player' ? 'Applies when something is playing.' : 'This phone does not support the equalizer.'));
      audioEffects.setBassBoost(bass).catch(() => undefined);
      save.current({equalizer: eq, bass_boost: bass}).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [eq, bass]);

  const band = (index: number, delta: number) => {
    const bands = eq.bands.map((gain, position) => (position === index ? Math.max(-LIMIT, Math.min(LIMIT, gain + delta)) : gain));
    setEq({...eq, bands, preset: 'custom', enabled: true});
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={typography.heading}>Equalizer</Text>
        <StarSwitch value={eq.enabled} onValueChange={enabled => setEq({...eq, enabled})} />
      </View>
      {status && <Text style={typography.caption}>{status}</Text>}
      <View style={styles.presets}>
        {Object.keys(PRESETS).map(name => (
          <Pressable key={name} onPress={() => setEq({...eq, preset: name, bands: PRESETS[name], enabled: true})}
            style={[styles.preset, eq.preset === name && accentStyle.fill]}>
            <Text style={[styles.presetLabel, eq.preset === name && [styles.presetLabelActive, accentStyle.onFill]]}>{name}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.bands}>
        {BANDS.map((label, index) => (
          <View key={label} style={styles.band}>
            <Pressable onPress={() => band(index, STEP)} hitSlop={6} accessibilityLabel={`Raise ${label} hertz`}>
              <Text style={styles.step}>＋</Text>
            </Pressable>
            <View style={styles.track}>
              <View style={[[styles.fill, accentStyle.fill], {height: `${((eq.bands[index] + LIMIT) / (2 * LIMIT)) * 100}%`}]} />
            </View>
            <Pressable onPress={() => band(index, -STEP)} hitSlop={6} accessibilityLabel={`Lower ${label} hertz`}>
              <Text style={styles.step}>－</Text>
            </Pressable>
            <Text style={styles.value}>{eq.bands[index] > 0 ? '+' : ''}{eq.bands[index]}</Text>
            <Text style={styles.label}>{label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Text style={typography.body}>Preamp {eq.preamp} dB</Text>
        <View style={styles.inline}>
          <Pressable onPress={() => setEq({...eq, preamp: Math.max(-LIMIT, eq.preamp - 1)})}><Text style={styles.step}>－</Text></Pressable>
          <Pressable onPress={() => setEq({...eq, preamp: Math.min(LIMIT, eq.preamp + 1)})}><Text style={styles.step}>＋</Text></Pressable>
        </View>
      </View>
      <View style={styles.row}>
        <Text style={typography.body}>Bass boost {bass}</Text>
        <View style={styles.inline}>
          <Pressable onPress={() => setBass(Math.max(0, bass - 1))}><Text style={styles.step}>－</Text></Pressable>
          <Pressable onPress={() => setBass(Math.min(12, bass + 1))}><Text style={styles.step}>＋</Text></Pressable>
        </View>
      </View>
      <Text style={typography.caption}>
        Effects run on the phone's own audio session through Android's equalizer, so they change what you hear,
        downloads included. Lossless sources are still decoded losslessly; the equalizer then shapes the output.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void, gap: spacing.md},
  row: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  presets: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs},
  preset: {paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineBright},
  presetLabelActive: {color: colors.onSelected, fontWeight: '700'},
  presetLabel: {color: colors.text, fontSize: 13, textTransform: 'capitalize'},
  bands: {flexDirection: 'row', justifyContent: 'space-between'},
  band: {alignItems: 'center', gap: 4},
  track: {width: 8, height: 140, borderRadius: 4, backgroundColor: colors.raised, justifyContent: 'flex-end', overflow: 'hidden'},
  fill: {width: 8},
  step: {color: colors.text, fontSize: 18, paddingHorizontal: 4},
  value: {color: colors.textDim, fontSize: 11},
  label: {color: colors.textFaint, fontSize: 10},
  inline: {flexDirection: 'row', gap: spacing.lg},
});
