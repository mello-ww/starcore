import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, useAccentStyles} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {PhotoGrid} from './PhotoGrid';
import type {AlbumDetail} from './types';
import {useFavorites} from './useFavorites';
import {usePhotoApi} from './usePhotoApi';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoAlbum'>;

/** One album's own grid - opened from the Albums tab. Not cached offline
 * the way the main Library is: an album is a much smaller, secondary view,
 * and always reachable from Albums again once the server is back.
 *
 * Rename/delete only ever apply to a custom (virtual) album - a physical
 * album's membership is automatic (it fills from its own source_paths
 * mapping) and Favorites can't be renamed or deleted (see albums.py's
 * FAVORITES_ID); the backend rejects both anyway, so this never even shows
 * the option. Every photo here still gets the same heart toggle every other
 * grid uses - unfavoriting from inside the Favorites album itself removes
 * it from this view immediately, the same way the web panel's own Favorites
 * detail behaves. */
export function PhotoAlbumScreen({route, navigation}: Props) {
  const accentStyle = useAccentStyles();
  const {albumId, name} = route.params;
  const {api} = usePhotoApi();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {favoriteIds, toggle: toggleFavorite} = useFavorites();

  const load = useCallback(async () => {
    try {
      setAlbum(await api.album(albumId));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load this album.');
    }
  }, [api, albumId]);

  useEffect(() => {
    load();
  }, [load]);

  const isCustom = album?.kind === 'virtual';

  const confirmDelete = useCallback(() => {
    if (!album) {
      return;
    }
    Alert.alert('Delete album?', `"${album.name}" will be deleted. The photos themselves are not affected.`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteAlbum(album.id);
            navigation.goBack();
          } catch (err: any) {
            Alert.alert('Could not delete this album', err?.message || 'Please try again.');
          }
        },
      },
    ]);
  }, [album, api, navigation]);

  useEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: isCustom
        ? () => (
            <Pressable onPress={confirmDelete} hitSlop={8}>
              <Text style={styles.headerAction}>Delete</Text>
            </Pressable>
          )
        : undefined,
    });
  }, [confirmDelete, isCustom, name, navigation]);

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
        <ActivityIndicator color={accentStyle.color} />
      </View>
    );
  }

  const onToggleFavorite = async (photo: {id: string}) => {
    try {
      const isFavoriteNow = await toggleFavorite(photo.id);
      if (album.kind === 'favorites' && !isFavoriteNow) {
        setAlbum(current => (current ? {...current, photos: current.photos.filter(p => p.id !== photo.id)} : current));
      }
    } catch {
      // the heart simply doesn't flip - see useFavorites' own optimistic rollback
    }
  };

  const emptyMessage =
    album.kind === 'physical'
      ? 'No photos have synced into this physical album yet.'
      : album.kind === 'favorites'
      ? "You haven't favorited anything yet."
      : 'This album is empty.';

  return (
    <View style={styles.screen}>
      <PhotoGrid
        photos={album.photos}
        favoriteIds={album.kind === 'physical' ? undefined : favoriteIds}
        onToggleFavorite={album.kind === 'physical' ? undefined : onToggleFavorite}
        onPressPhoto={(_photo, index) =>
          navigation.navigate('PhotoViewer', {
            media: album.photos.map(photo => ({id: photo.id, mediaType: photo.media_type, duration: photo.duration})),
            startIndex: index,
          })
        }
        emptyMessage={emptyMessage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void, padding: spacing.lg},
  error: {color: colors.alert, fontSize: 13},
  headerAction: {color: colors.alert, fontWeight: '600', paddingHorizontal: spacing.sm},
});
