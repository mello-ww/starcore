import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, radius, spacing, typography, useAccentStyles} from '../../theme';
import {Artwork, Mosaic} from '../ui/Artwork';

interface Props {
  title: string;
  subtitle?: string;
  details?: string;
  albumId?: string | null;
  mosaic?: string[];
  round?: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  actions?: {label: string; onPress: () => void; active?: boolean}[];
}

export function CollectionHeader({title, subtitle, details, albumId, mosaic, round, onPlay, onShuffle, actions = []}: Props) {
  const accentStyle = useAccentStyles();
  return (
    <View style={styles.header}>
      {mosaic ? <Mosaic albums={mosaic} size={200} label={title} /> : <Artwork albumId={albumId} size={200} round={round} label={title} />}
      <Text style={[typography.title, styles.title]}>{title}</Text>
      {!!subtitle && <Text style={typography.body}>{subtitle}</Text>}
      {!!details && <Text style={typography.caption}>{details}</Text>}
      <View style={styles.buttons}>
        {onPlay && (
          <Pressable onPress={onPlay} style={[styles.button, accentStyle.fill]} accessibilityLabel="Play">
            <Text style={[styles.label, styles.primaryLabel, accentStyle.onFill]}>▶ Play</Text>
          </Pressable>
        )}
        {onShuffle && (
          <Pressable onPress={onShuffle} style={styles.button} accessibilityLabel="Shuffle">
            <Text style={styles.label}>⇄ Shuffle</Text>
          </Pressable>
        )}
        {actions.map(action => (
          <Pressable key={action.label} onPress={action.onPress} style={[styles.button, action.active && accentStyle.border]}>
            <Text style={styles.label}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.xs},
  title: {textAlign: 'center', marginTop: spacing.md},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.md},
  button: {paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineBright},
  primaryLabel: {color: colors.onAccent, fontWeight: '700'},
  label: {color: colors.text, fontWeight: '600'},
});
