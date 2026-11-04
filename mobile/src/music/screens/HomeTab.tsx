import React, {useState} from 'react';
import {ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {HomeSection, Track} from '../types';
import {useMusicNavigation} from '../ui/navigation';
import {Shelf, type ShelfItem} from '../ui/Shelf';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../ui/TrackRow';
import {trackCount} from '../ui/format';
import {useLoad} from '../ui/useLoad';
import {FloatingPlayerSpacer} from '../../components/FloatingPlayerInset';

export function HomeTab() {
  const accentStyle = useAccentStyles();
  const {api, player} = useMusic();
  const go = useMusicNavigation();
  const {data, error, loading, reload} = useLoad(() => api.home(new Date().getHours()), [api]);
  const [actions, setActions] = useState<Track[] | null>(null);

  const items = (section: HomeSection): ShelfItem[] => {
    switch (section.kind) {
      case 'albums':
        return section.items.map(album => ({key: album.id, title: album.album, subtitle: album.artist, albumId: album.artwork ? album.id : null,
          onPress: () => go.album(album.id)}));
      case 'artists':
        return section.items.map(artist => ({key: artist.id, title: artist.name, subtitle: `${artist.tracks} songs`,
          albumId: artist.artwork, round: true, onPress: () => go.artist(artist.id)}));
      case 'mixes':
        return section.items.map(mix => ({key: mix.id, title: mix.name, subtitle: mix.description ?? `${trackCount(mix.tracks)} songs`,
          mosaic: mix.mosaic ?? [], onPress: () => go.tracks('mix', mix.id, mix.name)}));
      case 'moods':
        return section.items.map(mood => ({key: mood.id, title: mood.name, subtitle: mood.genres.slice(0, 2).join(', '),
          onPress: () => go.tracks('mood', mood.id, mood.name)}));
      case 'contexts':
        return section.items.map(entry => context(entry)).filter(Boolean) as ShelfItem[];
      default:
        return [];
    }
  };

  const context = (entry: any): ShelfItem | null => {
    const item = entry.item;
    if (entry.kind === 'album') {
      return {key: `a-${item.id}`, title: item.album, subtitle: item.artist, albumId: item.artwork ? item.id : null, onPress: () => go.album(item.id)};
    }
    if (entry.kind === 'playlist') {
      return {key: `p-${item.id}`, title: item.name, subtitle: 'Playlist', mosaic: item.mosaic ?? [], onPress: () => go.playlist(item.id)};
    }
    if (entry.kind === 'artist') {
      return {key: `r-${item.id}`, title: item.name, subtitle: 'Artist', round: true, onPress: () => go.artist(item.id)};
    }
    return null;
  };

  if (loading && !data) {
    return <ActivityIndicator color={accentStyle.color} style={styles.loading} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={accentStyle.color} />}>
      {error && <Text style={styles.error}>{error}</Text>}
      {data && <Text style={typography.title}>{data.greeting}</Text>}
      {data?.sections.length === 0 && (
        <Text style={[typography.caption, styles.empty]}>Your library is empty. Scan it from Mission Control or Music settings.</Text>
      )}
      {data?.sections.map(section =>
        section.kind === 'tracks' ? (
          <View key={section.id} style={styles.section}>
            <Text style={typography.heading}>{section.title}</Text>
            {!!section.subtitle && <Text style={typography.caption}>{section.subtitle}</Text>}
            {section.items.slice(0, 6).map((track: Track, index: number) => (
              <TrackRow key={`${section.id}-${track.id}`} track={track}
                onPress={() => player.playTracks(section.items, index, `queue:${section.id}`)}
                onMore={() => setActions([track])} />
            ))}
          </View>
        ) : (
          <Shelf key={section.id} title={section.title} subtitle={section.subtitle} items={items(section)} />
        ),
      )}
      <TrackActions tracks={actions} onClose={() => setActions(null)} />
      <FloatingPlayerSpacer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120},
  loading: {marginTop: spacing.xl},
  error: {color: colors.alert, marginBottom: spacing.md},
  empty: {marginTop: spacing.lg},
  section: {marginTop: spacing.lg},
});
