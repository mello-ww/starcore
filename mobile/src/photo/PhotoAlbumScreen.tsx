import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {colors, spacing} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {PhotoGrid} from './PhotoGrid';
import type {AlbumDetail} from './types';
import {usePhotoApi} from './usePhotoApi';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoAlbum'>;

/** One folder's own grid - opened from the Folders tab. Not cached offline
 * the way the main Library is: an album is a much smaller, secondary view,
 * and always reachable from Folders again once the server is back. */
export function PhotoAlbumScreen({route, navigation}: Props) {
  const {albumId, name} = route.params;
  const {api} = usePhotoApi();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlbum(await api.album(albumId));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load this folder.');
    }
  }, [api, albumId]);

  useEffect(() => {
    navigation.setOptions({title: name});
    load();
  }, [load, name, navigation]);

  if (error && !album) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!album) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.azure} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <PhotoGrid
        photos={album.photos}
        onPressPhoto={(_photo, index) =>
          navigation.navigate('PhotoViewer', {
            media: album.photos.map(photo => ({id: photo.id, mediaType: photo.media_type, duration: photo.duration})),
            startIndex: index,
          })
        }
        emptyMessage="This folder is empty."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void, padding: spacing.lg},
  error: {color: colors.alert, fontSize: 13},
});
