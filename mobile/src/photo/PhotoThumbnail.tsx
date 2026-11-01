import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, radius, useAccentStyles} from '../theme';
import {durationLabel} from './duration';
import {usePhotoApi} from './usePhotoApi';

interface Props {
  photoId: string;
  trashed?: boolean;
  size: number;
  onPress: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  /** Set for a video item - shows a play badge and, when known, its length.
   * A video with no server-rendered thumbnail (no ffmpeg on that StarCore
   * server - see PhotoLibrary.thumbnail_path) still shows these over the
   * fallback tile, exactly like the web panel's own gallery. */
  isVideo?: boolean;
  duration?: number | null;
  /** Undefined hides the heart entirely (e.g. the recycle bin's own tiles,
   * where favoriting doesn't apply) - present (even false) shows it. */
  favorite?: boolean;
  onToggleFavorite?: () => void;
}

/** One grid cell: a cached, authenticated thumbnail - never the full
 * original (see "avoid downloading full-resolution versions until
 * necessary" in the task brief). Loads its own image so PhotoGrid never has
 * to know anything about auth headers or the recycle-bin's separate
 * preview routes. */
export function PhotoThumbnail({
  photoId,
  trashed,
  size,
  onPress,
  onLongPress,
  selected,
  isVideo,
  duration,
  favorite,
  onToggleFavorite,
}: Props) {
  const accentStyle = useAccentStyles();
  const {imageSource} = usePhotoApi();
  const [failed, setFailed] = useState(false);
  const label = isVideo ? durationLabel(duration) : '';

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={[styles.cell, {width: size, height: size}]}>
      {!failed ? (
        <Image
          source={imageSource(photoId, 'thumbnail', trashed)}
          style={styles.image}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={[styles.image, styles.fallback]} />
      )}
      {isVideo && (
        <View style={styles.playBadge}>
          <View style={styles.playTriangle} />
        </View>
      )}
      {!!label && (
        <View style={styles.durationBadge}>
          <Text style={styles.durationLabel}>{label}</Text>
        </View>
      )}
      {selected !== undefined && (
        <View style={[styles.selectionDot, selected && accentStyle.fill]} />
      )}
      {favorite !== undefined && onToggleFavorite && (
        <Pressable
          onPress={onToggleFavorite}
          hitSlop={8}
          style={[styles.favoriteBadge, favorite && styles.favoriteBadgeActive]}>
          <Text style={[styles.favoriteIcon, favorite && styles.favoriteIconActive]}>{favorite ? '♥' : '♡'}</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {padding: 1.5, position: 'relative'},
  image: {flex: 1, borderRadius: radius.sm, backgroundColor: colors.raised},
  fallback: {alignItems: 'center', justifyContent: 'center'},
  selectionDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(4,6,13,0.35)',
  },
  favoriteBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4,6,13,0.45)',
  },
  favoriteBadgeActive: {
    backgroundColor: 'rgba(238,68,75,0.28)',
  },
  favoriteIcon: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 16,
  },
  favoriteIconActive: {
    color: colors.alert,
  },
  playBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -17,
    marginLeft: -17,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(4,6,13,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playTriangle: {
    marginLeft: 3,
    width: 0,
    height: 0,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 11,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#fff',
  },
  durationBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(4,6,13,0.72)',
  },
  durationLabel: {
    color: colors.text,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
});
