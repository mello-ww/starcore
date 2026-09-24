import React, {useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {colors, radius, spacing, typography} from '../theme';
import {PhotoGrid} from './PhotoGrid';
import type {AlbumSummary, Photo} from './types';
import {usePhotoApi} from './usePhotoApi';

const DEBOUNCE_MS = 300;

export function matches(photo: Photo, query: string): boolean {
  const haystack = [
    photo.filename,
    photo.metadata.camera_make,
    photo.metadata.camera_model,
    photo.metadata.lens_model,
    photo.captured_at,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

interface Props {
  onOpenPhoto: (photos: Photo[], index: number) => void;
  onOpenAlbum: (album: AlbumSummary) => void;
}

/**
 * The "Search" tab: filters over the metadata the server already sends with
 * every photo (filename, camera/lens, capture date) and over album names -
 * see "search photos and folders using the server's available metadata" in
 * the task brief. There is no content-based (AI/image) search anywhere in
 * the Photo satellite's API, so this never pretends to offer one.
 */
export function PhotoSearchTab({onOpenPhoto, onOpenAlbum}: Props) {
  const {api} = usePhotoApi();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [photoList, albumList] = await Promise.all([api.list(), api.albums()]);
        setPhotos(photoList);
        setAlbums(albumList);
      } finally {
        setLoaded(true);
      }
    })();
  }, [api]);

  useEffect(() => {
    const handle = setTimeout(() => setQuery(input.trim().toLowerCase()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  const matchingPhotos = useMemo(() => (query ? photos.filter(photo => matches(photo, query)) : []), [photos, query]);
  const matchingAlbums = useMemo(
    () => (query ? albums.filter(album => album.name.toLowerCase().includes(query)) : []),
    [albums, query],
  );

  return (
    <View style={styles.container}>
      <TextInput
        value={input}
        onChangeText={setInput}
        placeholder="Search filenames, camera, date…"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {!query ? (
        <View style={styles.empty}>
          <Text style={typography.caption}>{loaded ? 'Type to search your library.' : 'Loading…'}</Text>
        </View>
      ) : (
        <>
          {matchingAlbums.length > 0 && (
            <View style={styles.albumResults}>
              <Text style={[typography.label, styles.sectionLabel]}>Folders</Text>
              {matchingAlbums.map(album => (
                <Text key={album.id} style={[typography.body, styles.albumRow]} onPress={() => onOpenAlbum(album)}>
                  {album.name} · {album.photo_count} {album.photo_count === 1 ? 'photo' : 'photos'}
                </Text>
              ))}
            </View>
          )}
          <PhotoGrid
            photos={matchingPhotos}
            onPressPhoto={(photo, index) => onOpenPhoto(matchingPhotos, index)}
            emptyMessage={matchingAlbums.length ? '' : 'No photos match your search.'}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  input: {
    margin: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl},
  albumResults: {paddingHorizontal: spacing.md, gap: spacing.xs, marginBottom: spacing.sm},
  sectionLabel: {textTransform: 'uppercase', letterSpacing: 0.4},
  albumRow: {paddingVertical: spacing.xs},
});
