import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, TOUCH_TARGET, touchTarget, typography} from '../../theme';
import {useCurrentTrackId, useMusic} from '../MusicProvider';
import type {Track} from '../types';
import {Artwork} from './Artwork';
import {duration} from './format';

interface Props {
  track: Track;
  onPress: () => void;
  onMore?: () => void;
  showArtwork?: boolean;
  number?: number | null;
  subtitle?: string | null;
}

export function TrackRow({track, onPress, onMore, showArtwork = true, number, subtitle}: Props) {
  const {liked, downloads} = useMusic();
  const playingId = useCurrentTrackId();
  const active = playingId === track.id;
  const unavailable = !!track.missing;
  return (
    <Pressable
      onPress={unavailable ? undefined : onPress}
      onLongPress={onMore}
      style={({pressed}) => [styles.row, pressed && styles.pressed, unavailable && styles.unavailable]}
      accessibilityRole="button"
      accessibilityLabel={`${track.title} by ${track.artist ?? track.album_artist}`}>
      {showArtwork ? (
        <Artwork albumId={track.has_artwork ? track.album_id : null} size={44} label={track.title} />
      ) : (
        <Text style={styles.number}>{number ?? track.track ?? ''}</Text>
      )}
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.title, active && styles.active]}>
          {track.title || 'Unavailable track'}
        </Text>
        <Text numberOfLines={1} style={typography.caption}>
          {liked.has(track.id) ? '♥ ' : ''}
          {downloads.isDownloaded(track.id) ? '↓ ' : ''}
          {track.quality?.hires ? 'Hi-Res · ' : track.quality?.lossless ? 'Lossless · ' : ''}
          {subtitle ?? track.reason ?? track.artist ?? track.album_artist ?? ''}
        </Text>
      </View>
      <Text style={styles.time}>{duration(track.duration)}</Text>
      {onMore && (
        <Pressable onPress={onMore} style={styles.more} accessibilityRole="button" accessibilityLabel="Track options">
          <Text style={styles.moreGlyph}>⋮</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', minHeight: TOUCH_TARGET, paddingVertical: spacing.xs, gap: spacing.md},
  pressed: {opacity: 0.6},
  unavailable: {opacity: 0.4},
  number: {width: 28, textAlign: 'center', color: colors.textFaint},
  text: {flex: 1},
  title: {...typography.body},
  active: {color: colors.azure},
  time: {...typography.label},
  more: touchTarget,
  moreGlyph: {color: colors.textDim, fontSize: 20},
});
