import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, radius, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic, usePlayerState} from '../MusicProvider';
import {bytes} from '../ui/format';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP = [15, 30, 45, 60];

function Line({label, value}: {label: string; value: string | number | null | undefined}) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return (
    <View style={styles.line}>
      <Text style={typography.label}>{label}</Text>
      <Text style={typography.body}>{String(value)}</Text>
    </View>
  );
}

/** Quality, delivery, credits and file details, plus speed and the sleep timer. */
export function InfoPanel() {
  const accentStyle = useAccentStyles();
  const {player} = useMusic();
  const state = usePlayerState();
  const track = state.track;
  if (!track) {
    return null;
  }
  const plan = state.plan;
  const delivery = state.source?.local
    ? 'Downloaded copy on this phone'
    : plan
      ? plan.delivery === 'transcode'
        ? `Transcoded to ${plan.codec?.toUpperCase()} ${Math.round((plan.bitrate ?? 0) / 1000)} kbps`
        : `Original file${plan.reason ? ` (${plan.reason})` : ''}`
      : 'Original file';
  const sleepLeft = state.sleepAt ? Math.max(0, Math.round((state.sleepAt - Date.now()) / 60000)) : null;

  return (
    <ScrollView>
      <Text style={typography.heading}>Playback</Text>
      <View style={styles.options}>
        {SPEEDS.map(speed => (
          <Pressable key={speed} onPress={() => player.setSpeed(speed)} style={[styles.option, state.speed === speed && accentStyle.fill]}>
            <Text style={[styles.optionLabel, state.speed === speed && [styles.optionLabelActive, accentStyle.onFill]]}>{speed}×</Text>
          </Pressable>
        ))}
      </View>
      <Text style={typography.label}>
        Sleep timer {state.sleepAtEnd ? '· end of this song' : sleepLeft !== null ? `· ${sleepLeft} min left` : ''}
      </Text>
      <View style={styles.options}>
        {SLEEP.map(minutes => (
          <Pressable key={minutes} onPress={() => player.setSleep(minutes)} style={styles.option}>
            <Text style={styles.optionLabel}>{minutes} min</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => player.setSleep('end')} style={[styles.option, state.sleepAtEnd && accentStyle.fill]}>
          <Text style={[styles.optionLabel, state.sleepAtEnd && [styles.optionLabelActive, accentStyle.onFill]]}>End of song</Text>
        </Pressable>
        {(state.sleepAt || state.sleepAtEnd) && (
          <Pressable onPress={() => player.setSleep(null)} style={styles.option}>
            <Text style={styles.optionLabel}>Off</Text>
          </Pressable>
        )}
      </View>

      <Text style={[typography.heading, styles.heading]}>Quality</Text>
      <Line label="Source" value={track.quality.label} />
      <Line label="Delivery" value={delivery} />
      <Line label="Format" value={`${track.format.toUpperCase()}${track.codec && track.codec !== track.format ? ` (${track.codec})` : ''}`} />
      <Line label="Sample rate" value={track.sample_rate ? `${track.sample_rate / 1000} kHz` : null} />
      <Line label="Bit depth" value={track.bit_depth ? `${track.bit_depth}-bit` : null} />
      <Line label="Bitrate" value={track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null} />
      <Line label="Channels" value={track.channels} />
      <Line label="Size" value={track.size ? bytes(track.size) : null} />
      <Line label="ReplayGain" value={track.replaygain?.album_gain ?? track.replaygain?.track_gain ?? null} />

      <Text style={[typography.heading, styles.heading]}>Credits</Text>
      <Line label="Artist" value={track.artists.map(artist => artist.name).join(', ')} />
      <Line label="Album" value={track.album} />
      <Line label="Album artist" value={track.album_artist} />
      <Line label="Composer" value={track.credits?.composer} />
      <Line label="Producer" value={track.credits?.producer} />
      <Line label="Label" value={track.credits?.label} />
      <Line label="Released" value={track.date ?? track.year} />
      <Line label="Genre" value={track.genre} />
      <Line label="ISRC" value={track.credits?.isrc} />
      <Line label="Copyright" value={track.credits?.copyright} />
      <Line label="File" value={track.filename} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  heading: {marginTop: spacing.lg},
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.sm},
  option: {paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineBright},
  optionLabelActive: {color: colors.onSelected, fontWeight: '700'},
  optionLabel: {color: colors.text, fontSize: 13},
  line: {paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line},
});
