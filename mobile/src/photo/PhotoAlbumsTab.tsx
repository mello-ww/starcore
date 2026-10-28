import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Card} from '../components/Card';
import {colors, radius, spacing, typography} from '../theme';
import {PhotoThumbnail} from './PhotoThumbnail';
import type {AlbumSummary} from './types';
import {usePhotoApi} from './usePhotoApi';

interface Props {
  onOpenAlbum: (album: AlbumSummary) => void;
  onOpenTrash: () => void;
}

function kindLabel(kind: AlbumSummary['kind']): string | null {
  if (kind === 'physical') {
    return 'Physical';
  }
  if (kind === 'favorites') {
    return 'Favorites';
  }
  return null;
}

/**
 * The unified "Albums" section - Physical albums (from Photo configuration's
 * source_paths), Favorites, Custom (virtual) albums, and the Recycle bin -
 * replacing the old "Folders" tab so mobile matches the web panel's own
 * Albums tab exactly (see mission_control/page.js's renderAlbums() and
 * docs/satellites/photo.md, "Albums"). Rename/delete never apply to a
 * physical album (its membership is automatic) or to Favorites (a fixed
 * album - see albums.py's FAVORITES_ID); the backend rejects both anyway.
 */
export function PhotoAlbumsTab({onOpenAlbum, onOpenTrash}: Props) {
  const {api} = usePhotoApi();
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.albums();
      setAlbums(loaded);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load your albums.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const createAlbum = async () => {
    const name = newName.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      await api.createAlbum(name);
      setNewName('');
      setCreating(false);
      await load();
    } catch (err: any) {
      Alert.alert('Could not create album', err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (album: AlbumSummary) => {
    Alert.alert('Delete album?', `"${album.name}" will be deleted. The photos themselves are not affected.`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteAlbum(album.id);
            await load();
          } catch (err: any) {
            Alert.alert('Could not delete this album', err?.message || 'Please try again.');
          }
        },
      },
    ]);
  };

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
        <ActivityIndicator color={colors.azure} />
      </View>
    );
  }

  const physical = albums.filter(album => album.kind === 'physical');
  const favorites = albums.find(album => album.kind === 'favorites');
  const custom = albums.filter(album => album.kind === 'virtual');

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Section title="Physical albums" hint="From Photo configuration's source-path mappings.">
        {physical.length === 0 ? (
          <Text style={[typography.caption, styles.sectionEmpty]}>No source paths configured yet.</Text>
        ) : (
          physical.map(album => (
            <AlbumRow key={album.id} album={album} onPress={() => onOpenAlbum(album)} />
          ))
        )}
      </Section>

      {favorites && (
        <Section title="Favorites">
          <AlbumRow album={favorites} onPress={() => onOpenAlbum(favorites)} />
        </Section>
      )}

      <Section
        title="Custom albums"
        action={
          <Pressable onPress={() => setCreating(current => !current)} hitSlop={8}>
            <Text style={styles.addAction}>{creating ? 'Cancel' : '+ New'}</Text>
          </Pressable>
        }>
        {creating && (
          <View style={styles.createRow}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Album name"
              placeholderTextColor={colors.textFaint}
              style={styles.createInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={createAlbum}
            />
            <Pressable onPress={createAlbum} disabled={busy} style={styles.createButton}>
              <Text style={styles.createButtonLabel}>{busy ? '…' : 'Create'}</Text>
            </Pressable>
          </View>
        )}
        {custom.length === 0 ? (
          <Text style={[typography.caption, styles.sectionEmpty]}>No custom albums yet.</Text>
        ) : (
          custom.map(album => (
            <AlbumRow
              key={album.id}
              album={album}
              onPress={() => onOpenAlbum(album)}
              onDelete={() => confirmDelete(album)}
            />
          ))
        )}
      </Section>

      <Section title="Recycle bin">
        <Pressable onPress={onOpenTrash}>
          <Card style={styles.card}>
            <View style={[styles.cover, styles.coverEmpty, styles.trashCover]}>
              <Text style={styles.trashIcon}>🗑</Text>
            </View>
            <View style={styles.info}>
              <Text style={typography.heading}>Recycle bin</Text>
              <Text style={typography.caption}>Deleted photos, until restored or erased</Text>
            </View>
          </Card>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function Section({title, hint, action, children}: {title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[typography.label, styles.sectionTitle]}>{title}</Text>
        {action}
      </View>
      {hint && <Text style={[typography.caption, styles.sectionHint]}>{hint}</Text>}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function AlbumRow({album, onPress, onDelete}: {album: AlbumSummary; onPress: () => void; onDelete?: () => void}) {
  const label = kindLabel(album.kind);
  return (
    <Pressable onPress={onPress}>
      <Card style={styles.card}>
        <View style={styles.cover}>
          {album.cover_photo_id ? (
            <PhotoThumbnail photoId={album.cover_photo_id} size={56} onPress={onPress} />
          ) : (
            <View
              style={[styles.cover, styles.coverEmpty, album.kind === 'favorites' && styles.favoritesCover]}>
              {album.kind === 'favorites' && <Text style={styles.trashIcon}>♥</Text>}
            </View>
          )}
        </View>
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text style={typography.heading}>{album.name}</Text>
            {label && (
              <View style={[styles.kindBadge, album.kind === 'favorites' && styles.kindBadgeFavorites]}>
                <Text style={styles.kindBadgeLabel}>{label}</Text>
              </View>
            )}
          </View>
          <Text style={typography.caption}>
            {album.photo_count} {album.photo_count === 1 ? 'photo' : 'photos'}
          </Text>
        </View>
        {onDelete && (
          <Pressable onPress={onDelete} hitSlop={8} style={styles.deleteAction}>
            <Text style={styles.deleteActionLabel}>✕</Text>
          </Pressable>
        )}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: {gap: spacing.lg, padding: spacing.md},
  section: {gap: spacing.sm},
  sectionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  sectionTitle: {textTransform: 'uppercase', letterSpacing: 0.4},
  sectionHint: {color: colors.textFaint},
  sectionBody: {gap: spacing.sm},
  sectionEmpty: {paddingVertical: spacing.xs},
  addAction: {color: colors.azure, fontWeight: '600', fontSize: 14},
  createRow: {flexDirection: 'row', gap: spacing.sm, alignItems: 'center'},
  createInput: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  createButton: {paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.raised},
  createButtonLabel: {color: colors.text, fontWeight: '600'},
  card: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  cover: {width: 56, height: 56, borderRadius: radius.md, overflow: 'hidden'},
  coverEmpty: {backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center'},
  favoritesCover: {backgroundColor: 'rgba(228,96,109,0.16)'},
  trashCover: {backgroundColor: colors.raised},
  trashIcon: {fontSize: 20, color: colors.alert},
  info: {flex: 1, gap: 2},
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs},
  kindBadge: {paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(15,82,186,0.22)'},
  kindBadgeFavorites: {backgroundColor: 'rgba(228,96,109,0.2)'},
  kindBadgeLabel: {fontSize: 10, fontWeight: '700', color: colors.ice, textTransform: 'uppercase'},
  deleteAction: {padding: spacing.xs},
  deleteActionLabel: {color: colors.textFaint, fontSize: 16},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg},
  error: {color: colors.alert, fontSize: 13},
});
