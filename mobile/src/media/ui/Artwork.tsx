import React, {useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {colors, radius} from '../../theme';
import {useArtworkUri} from '../AudioHost';

export function Artwork({albumId, size, round, label}: {albumId?: string | null; size: number; round?: boolean; label?: string}) {
  const source = useArtworkUri(albumId, size > 160 ? 600 : 300);
  const [failed, setFailed] = useState(false);
  const shape = {width: size, height: size, borderRadius: round ? size / 2 : radius.md};
  if (!source || failed) {
    return (
      <View style={[styles.fallback, shape]}>
        <Text style={[styles.glyph, {fontSize: size / 3}]}>{label ? label.slice(0, 1).toUpperCase() : '♪'}</Text>
      </View>
    );
  }
  return <Image source={source} style={[styles.image, shape]} onError={() => setFailed(true)} />;
}

/** A playlist cover: up to four album covers, or one when that's all there is. */
export function Mosaic({albums, size, label}: {albums: string[]; size: number; label?: string}) {
  if (albums.length < 4) {
    return <Artwork albumId={albums[0]} size={size} label={label} />;
  }
  const half = size / 2;
  return (
    <View style={[styles.grid, {width: size, height: size}]}>
      {albums.slice(0, 4).map(album => (
        <Artwork key={album} albumId={album} size={half} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {backgroundColor: colors.raised},
  fallback: {backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center'},
  glyph: {color: colors.textFaint},
  grid: {flexDirection: 'row', flexWrap: 'wrap', borderRadius: radius.md, overflow: 'hidden'},
});
