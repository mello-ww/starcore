import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Dimensions, FlatList, Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, radius, spacing, typography} from '../theme';
import {durationLabel} from './duration';
import type {Photo} from './types';
import {usePhotoApi} from './usePhotoApi';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const COLUMNS = 3;
const GUTTER = spacing.md * 2;

/** How much longer a trashed photo has before it's purged automatically -
 * mirrors the wording and math of daysRemaining() in the web panel's
 * mission_control/page.js, from the same trashed_at + retention_days the
 * server sends. Exported for testing, same convention as dateLabel/matches
 * elsewhere in this folder. */
export function daysRemaining(trashedAt: string | null | undefined, retentionDays: number | null): string {
  if (!trashedAt || retentionDays == null) {
    return '';
  }
  const trashedDate = new Date(trashedAt);
  if (Number.isNaN(trashedDate.getTime())) {
    return '';
  }
  const elapsedDays = (Date.now() - trashedDate.getTime()) / 86400000;
  const remaining = Math.max(0, Math.ceil(retentionDays - elapsedDays));
  return remaining <= 0 ? 'Erasing soon' : `${remaining} day${remaining === 1 ? '' : 's'} left`;
}

/**
 * The mobile Recycle Bin - lists exactly what GET /trash reports, the same
 * bin the web panel's own "Recycle bin" tab and the backend API share (see
 * "Recycle bin" in docs/satellites/photo.md). Restore and permanent erase
 * call the same trash/<id>/restore and trash/<id>/erase routes the web
 * panel and PhotoLibraryTab/PhotoViewerScreen's own delete-to-trash actions
 * already use - there is no second recycle-bin implementation here.
 */
export function PhotoTrashTab() {
  const {api, imageSource} = usePhotoApi();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listing = await api.trashList();
      setPhotos(listing.photos);
      setRetentionDays(listing.retention_days);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the recycle bin.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const restore = async (photo: Photo) => {
    setBusyId(photo.id);
    try {
      await api.restore(photo.id);
      setPhotos(current => (current ?? []).filter(candidate => candidate.id !== photo.id));
    } catch (err: any) {
      Alert.alert('Could not restore', err?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmErase = (photo: Photo) => {
    Alert.alert(
      'Permanently erase photo?',
      `"${photo.filename}" will be erased for good. This cannot be undone.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Erase permanently',
          style: 'destructive',
          onPress: async () => {
            setBusyId(photo.id);
            try {
              await api.erase(photo.id);
              setPhotos(current => (current ?? []).filter(candidate => candidate.id !== photo.id));
            } catch (err: any) {
              Alert.alert('Could not erase', err?.message || 'Please try again.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  const cellSize = (Dimensions.get('window').width - GUTTER) / COLUMNS;

  return (
    <View style={styles.container}>
      {retentionDays != null && (
        <Text style={[typography.caption, styles.retentionNote]}>
          Deleted photos stay here for {retentionDays} day{retentionDays === 1 ? '' : 's'}, then are permanently
          erased. Restore one any time before then, or erase it yourself right away.
        </Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        ListFooterComponent={<FloatingPlayerSpacer />}
        data={photos ?? []}
        keyExtractor={photo => photo.id}
        numColumns={COLUMNS}
        contentContainerStyle={styles.grid}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListEmptyComponent={
          photos !== null ? (
            <Text style={[typography.caption, styles.empty]}>
              {error ? '' : 'The recycle bin is empty.'}
            </Text>
          ) : null
        }
        renderItem={({item}) => (
          <View style={[styles.cell, {width: cellSize}]}>
            <Image source={imageSource(item.id, 'thumbnail', true)} style={[styles.image, {height: cellSize}]} />
            <Text style={[typography.caption, styles.caption]} numberOfLines={1}>
              {item.media_type === 'video' ? `▶ ${durationLabel(item.duration)} · ` : ''}
              {item.filename}
            </Text>
            {!!daysRemaining(item.trashed_at, retentionDays) && (
              <Text style={styles.remaining}>{daysRemaining(item.trashed_at, retentionDays)}</Text>
            )}
            <View style={styles.actions}>
              <Pressable
                style={styles.actionButton}
                disabled={busyId === item.id}
                onPress={() => restore(item)}>
                <Text style={styles.actionLabel}>Restore</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.eraseButton]}
                disabled={busyId === item.id}
                onPress={() => confirmErase(item)}>
                <Text style={[styles.actionLabel, styles.eraseLabel]}>Erase</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  retentionNote: {paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs},
  error: {color: colors.alert, fontSize: 13, paddingHorizontal: spacing.md, paddingTop: spacing.sm},
  empty: {flex: 1, textAlign: 'center', marginTop: spacing.xl},
  grid: {padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm},
  cell: {padding: 4},
  image: {width: '100%', borderRadius: radius.sm, backgroundColor: colors.raised},
  caption: {marginTop: spacing.xs},
  remaining: {color: colors.textFaint, fontSize: 11, marginTop: 1},
  actions: {flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs},
  actionButton: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.lineBright,
    alignItems: 'center',
  },
  eraseButton: {borderColor: colors.alert},
  actionLabel: {color: colors.text, fontSize: 12, fontWeight: '600'},
  eraseLabel: {color: colors.alert},
});
