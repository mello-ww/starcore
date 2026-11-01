import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {Card} from '../components/Card';
import {colors, radius, spacing, typography, useAccentStyles} from '../theme';
import {PhotoThumbnail} from './PhotoThumbnail';
import type {AlbumSummary} from './types';
import {usePhotoApi} from './usePhotoApi';

interface Props {
  onOpenAlbum: (album: AlbumSummary) => void;
}

/**
 * The "Folders" tab: StarCore's own albums (see albums.py), shown as
 * folders per the task brief. The Photo satellite's albums are flat - there
 * is no nested-folder concept anywhere in the server's data model (see
 * docs/satellites/photo.md) - so this deliberately never invents nesting.
 */
export function PhotoFoldersTab({onOpenAlbum}: Props) {
  const accentStyle = useAccentStyles();
  const {api} = usePhotoApi();
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api.albums();
      setAlbums(loaded);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load your folders.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !albums) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!albums) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={accentStyle.color} />
      </View>
    );
  }

  return (
    <FlatList
      data={albums}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={[typography.caption, styles.empty]}>No folders yet.</Text>}
      renderItem={({item}) => (
        <Pressable onPress={() => onOpenAlbum(item)}>
          <Card style={styles.card}>
            <View style={styles.cover}>
              {item.cover_photo_id ? (
                <PhotoThumbnail photoId={item.cover_photo_id} size={56} onPress={() => onOpenAlbum(item)} />
              ) : (
                <View style={[styles.cover, styles.coverEmpty]} />
              )}
            </View>
            <View style={styles.info}>
              <Text style={typography.heading}>{item.name}</Text>
              <Text style={typography.caption}>
                {item.photo_count} {item.photo_count === 1 ? 'photo' : 'photos'}
              </Text>
            </View>
          </Card>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {gap: spacing.sm, padding: spacing.md},
  card: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  cover: {width: 56, height: 56, borderRadius: radius.md, overflow: 'hidden'},
  coverEmpty: {backgroundColor: colors.raised},
  info: {flex: 1, gap: 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg},
  error: {color: colors.alert, fontSize: 13},
  empty: {padding: spacing.lg, textAlign: 'center'},
});
