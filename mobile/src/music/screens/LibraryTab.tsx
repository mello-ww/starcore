import React, {useMemo, useState} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {colors, radius, spacing, typography} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {Album, Artist, Playlist} from '../types';
import {Artwork, Mosaic} from '../ui/Artwork';
import {trackCount} from '../ui/format';
import {useMusicNavigation} from '../ui/navigation';
import {useLoad} from '../ui/useLoad';

type Filter = 'playlists' | 'albums' | 'artists';
const FILTERS: {key: Filter; label: string}[] = [
  {key: 'playlists', label: 'Playlists'},
  {key: 'albums', label: 'Albums'},
  {key: 'artists', label: 'Artists'},
];

interface Row {
  key: string;
  title: string;
  subtitle: string;
  albumId?: string | null;
  mosaic?: string[];
  round?: boolean;
  onPress: () => void;
}

export function LibraryTab() {
  const {api, downloads} = useMusic();
  const go = useMusicNavigation();
  const [filter, setFilter] = useState<Filter>('playlists');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [needle, setNeedle] = useState('');
  const playlists = useLoad(() => api.playlists(), [api]);
  const albums = useLoad<Album[]>(() => (filter === 'albums' ? api.albums('added') : Promise.resolve([])), [api, filter]);
  const artists = useLoad<Artist[]>(() => (filter === 'artists' ? api.artists() : Promise.resolve([])), [api, filter]);

  const create = () =>
    Alert.prompt
      ? Alert.prompt('New playlist', undefined, name => name && api.createPlaylist(name).then(playlists.reload))
      : api.createPlaylist(`My playlist ${new Date().toLocaleDateString()}`).then(created => go.playlist(created.id));

  const rows: Row[] = useMemo(() => {
    let list: Row[] = [];
    if (filter === 'playlists') {
      list = [
        {key: 'liked', title: 'Liked Songs', subtitle: 'Your favourite tracks', onPress: () => go.tracks('liked', 'liked', 'Liked Songs')},
        {key: 'recent', title: 'Recently played', subtitle: 'From your history', onPress: () => go.tracks('recent', 'recent', 'Recently played')},
        {key: 'downloads', title: 'Downloads', subtitle: `${downloads.list().length} songs on this phone`, onPress: () => go.downloads()},
        ...(playlists.data ?? []).map((playlist: Playlist) => ({
          key: playlist.id,
          title: `${playlist.pinned ? '📌 ' : ''}${playlist.name}`,
          subtitle: `${playlist.smart ? 'Smart playlist' : 'Playlist'} · ${trackCount(playlist.tracks)} songs${playlist.folder ? ` · ${playlist.folder}` : ''}`,
          mosaic: playlist.mosaic,
          onPress: () => go.playlist(playlist.id),
        })),
      ];
    } else if (filter === 'albums') {
      list = (albums.data ?? []).map(album => ({key: album.id, title: album.album, subtitle: `${album.artist}${album.year ? ` · ${album.year}` : ''}`,
        albumId: album.artwork ? album.id : null, onPress: () => go.album(album.id)}));
    } else {
      list = (artists.data ?? []).map(artist => ({key: artist.id, title: artist.name, subtitle: `${artist.albums} albums`,
        albumId: artist.artwork, round: true, onPress: () => go.artist(artist.id)}));
    }
    const text = needle.trim().toLowerCase();
    if (text) {
      list = list.filter(row => row.title.toLowerCase().includes(text) || row.subtitle.toLowerCase().includes(text));
    }
    if (sort === 'name') {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [albums.data, artists.data, downloads, filter, go, needle, playlists.data, sort]);

  return (
    <View style={styles.screen}>
      <View style={styles.filters}>
        {FILTERS.map(option => (
          <Pressable key={option.key} onPress={() => setFilter(option.key)} style={[styles.chip, filter === option.key && styles.chipActive]}>
            <Text style={styles.chipLabel}>{option.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setSort(sort === 'recent' ? 'name' : 'recent')} style={styles.chip}>
          <Text style={styles.chipLabel}>{sort === 'recent' ? 'Recent' : 'A–Z'}</Text>
        </Pressable>
      </View>
      <View style={styles.tools}>
        <TextInput value={needle} onChangeText={setNeedle} placeholder="Find in library" placeholderTextColor={colors.textFaint} style={styles.input} />
        {filter === 'playlists' && (
          <Pressable onPress={create} style={styles.add} accessibilityLabel="New playlist">
            <Text style={styles.addLabel}>＋</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        data={rows}
        keyExtractor={row => row.key}
        contentContainerStyle={styles.list}
        onRefresh={() => (filter === 'playlists' ? playlists.reload() : filter === 'albums' ? albums.reload() : artists.reload())}
        refreshing={false}
        ListEmptyComponent={<Text style={typography.caption}>{needle ? 'Nothing matches.' : 'Nothing here yet.'}</Text>}
        renderItem={({item}) => (
          <Pressable onPress={item.onPress} style={styles.row}>
            {item.mosaic ? <Mosaic albums={item.mosaic} size={56} label={item.title} /> :
              <Artwork albumId={item.albumId} size={56} round={item.round} label={item.title} />}
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={typography.body}>{item.title}</Text>
              <Text numberOfLines={1} style={typography.caption}>{item.subtitle}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1},
  filters: {flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.md},
  chip: {paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: colors.lineBright},
  chipActive: {backgroundColor: colors.royal, borderColor: colors.royal},
  chipLabel: {color: colors.text, fontSize: 13},
  tools: {flexDirection: 'row', gap: spacing.sm, padding: spacing.md},
  input: {flex: 1, backgroundColor: colors.raised, color: colors.text, borderRadius: radius.md, paddingHorizontal: spacing.md},
  add: {width: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised, borderRadius: radius.md},
  addLabel: {color: colors.text, fontSize: 22},
  list: {paddingHorizontal: spacing.md, paddingBottom: 120},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm},
  rowText: {flex: 1},
});
