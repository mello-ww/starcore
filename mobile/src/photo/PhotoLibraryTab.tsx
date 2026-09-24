import React, {useCallback, useEffect, useState} from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography} from '../theme';
import {getCachedPhotos, setCachedPhotos} from './cache';
import {PhotoGrid} from './PhotoGrid';
import type {Photo} from './types';
import {usePhotoApi} from './usePhotoApi';

interface Props {
  onOpenPhoto: (photos: Photo[], index: number) => void;
}

/** The "Photo Library" tab: every photo on this server, newest first,
 * grouped by date - the main timeline described in the task brief. Shows
 * cached photos immediately (clearly marked) while the live list loads, and
 * keeps showing them if the server is temporarily unreachable, exactly like
 * SatellitesListScreen already does for the Satellites list. */
export function PhotoLibraryTab({onOpenPhoto}: Props) {
  const {api, serverId} = usePhotoApi();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [isCache, setIsCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!serverId) {
      return;
    }
    const cached = await getCachedPhotos(serverId);
    if (cached) {
      setPhotos(cached);
      setIsCache(true);
    }
    try {
      const live = await api.list();
      setPhotos(live);
      setIsCache(false);
      setError(null);
      await setCachedPhotos(serverId, live);
    } catch (err: any) {
      if (!cached) {
        setError(err?.message || 'Could not load your photos.');
      }
    }
  }, [api, serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const toggleSelected = (photo: Photo) => {
    setSelection(current => {
      const next = new Set(current ?? []);
      if (next.has(photo.id)) {
        next.delete(photo.id);
      } else {
        next.add(photo.id);
      }
      return next.size ? next : null;
    });
  };

  const deleteSelected = () => {
    if (!selection) {
      return;
    }
    const ids = [...selection];
    Alert.alert(
      ids.length === 1 ? 'Delete photo?' : `Delete ${ids.length} photos?`,
      'They will move to the recycle bin and can be restored from there.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSelection(null);
            await Promise.all(ids.map(id => api.trash(id).catch(() => {})));
            await load();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      {isCache && <Text style={[typography.caption, styles.offline]}>Showing cached photos - offline</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <PhotoGrid
        photos={photos ?? []}
        groupByDate
        refreshing={refreshing}
        onRefresh={onRefresh}
        selectedIds={selection ?? undefined}
        onPressPhoto={(photo, index) => {
          if (selection) {
            toggleSelected(photo);
          } else {
            onOpenPhoto(photos ?? [], index);
          }
        }}
        onLongPressPhoto={toggleSelected}
        emptyMessage={photos === null ? 'Loading your photos…' : 'No photos yet. Import some from your Folders tab.'}
      />
      {selection && (
        <View style={styles.selectionBar}>
          <Text style={typography.body}>{selection.size} selected</Text>
          <PrimaryButton title="Delete" variant="secondary" onPress={deleteSelected} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  offline: {color: colors.textFaint, paddingHorizontal: spacing.md, paddingTop: spacing.sm},
  error: {color: colors.alert, fontSize: 13, paddingHorizontal: spacing.md, paddingTop: spacing.sm},
  selectionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
  },
});
