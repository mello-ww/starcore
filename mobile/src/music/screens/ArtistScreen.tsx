import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {SatellitesStackParamList} from '../../navigation/MainTabs';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {Album, Track} from '../types';
import {useMusicNavigation} from '../ui/navigation';
import {Shelf, type ShelfItem} from '../ui/Shelf';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../ui/TrackRow';
import {useLoad} from '../ui/useLoad';
import {CollectionHeader} from './CollectionHeader';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'MusicArtist'>;

export function ArtistScreen({route}: Props) {
  const accentStyle = useAccentStyles();
  const {api, player} = useMusic();
  const go = useMusicNavigation();
  const {data: artist, error, setData} = useLoad(() => api.artist(route.params.id), [api, route.params.id]);
  const [actions, setActions] = useState<Track[] | null>(null);

  if (!artist) {
    return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={accentStyle.color} style={styles.loading} />;
  }
  const albums = (list: Album[]): ShelfItem[] =>
    list.map(album => ({key: album.id, title: album.album, subtitle: album.year ? String(album.year) : album.type,
      albumId: album.artwork ? album.id : null, onPress: () => go.album(album.id)}));
  const context = `artist:${artist.id}`;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <CollectionHeader
        title={artist.name}
        details={artist.genres.slice(0, 3).join(' · ')}
        albumId={artist.artwork}
        round
        onPlay={() => player.playTracks(artist.top_tracks, 0, context, false)}
        actions={[
          {label: artist.followed ? 'Following' : 'Follow', active: artist.followed, onPress: () =>
            api.setFavorite('artist', [artist.id], !artist.followed).then(() => setData({...artist, followed: !artist.followed}))},
          {label: 'Radio', onPress: () => api.radio('artist', artist.id).then(station =>
            player.playTracks(station.tracks, 0, `radio:${artist.id}`))},
        ]}
      />
      {artist.top_tracks.length > 0 && (
        <View>
          <Text style={typography.heading}>Top songs</Text>
          {artist.top_tracks.slice(0, 5).map((track, index) => (
            <TrackRow key={track.id} track={track} onPress={() => player.playTracks(artist.top_tracks, index, context, false)}
              onMore={() => setActions([track])} subtitle={track.plays ? `${track.plays} plays` : track.album} />
          ))}
        </View>
      )}
      <Shelf title="Albums" items={albums(artist.albums)} />
      <Shelf title="Singles and EPs" items={albums(artist.singles)} />
      <Shelf title="Appears on" items={albums(artist.appears_on)} />
      <Shelf title="Similar in your library" items={artist.similar.map(other => ({key: other.id, title: other.name,
        subtitle: other.reason, round: true, onPress: () => go.artist(other.id)}))} />
      <TrackActions tracks={actions} onClose={() => setActions(null)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void},
  loading: {marginTop: spacing.xl},
  error: {color: colors.alert, padding: spacing.md},
});
