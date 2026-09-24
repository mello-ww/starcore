import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, radius} from '../theme';
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
}

/** One grid cell: a cached, authenticated thumbnail - never the full
 * original (see "avoid downloading full-resolution versions until
 * necessary" in the task brief). Loads its own image so PhotoGrid never has
 * to know anything about auth headers or the recycle-bin's separate
 * preview routes. */
export function PhotoThumbnail({photoId, trashed, size, onPress, onLongPress, selected, isVideo, duration}: Props) {
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
        <View style={[styles.selectionDot, selected && styles.selectionDotActive]} />
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
  selectionDotActive: {
    backgroundColor: colors.azure,
    borderColor: colors.azure,
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
