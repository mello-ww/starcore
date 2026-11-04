import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {ActivityIndicator, Alert, ScrollView, StyleSheet, Text} from 'react-native';
import type {SatellitesStackParamList} from '../../navigation/MainTabs';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {Track} from '../types';
import {longDuration} from '../ui/format';
import {useMusicNavigation} from '../ui/navigation';
import {Shelf} from '../ui/Shelf';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../ui/TrackRow';
import {useLoad} from '../ui/useLoad';
import {CollectionHeader} from './CollectionHeader';
import {FloatingPlayerSpacer} from '../../components/FloatingPlayerInset';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'MusicAlbum'>;

export function AlbumScreen({route}: Props) {
  const accentStyle = useAccentStyles();
  const {api, player, downloads} = useMusic();
  const go = useMusicNavigation();
  const {data: album, error, setData} = useLoad(() => api.album(route.params.id), [api, route.params.id]);
  const [actions, setActions] = useState<Track[] | null>(null);

  if (!album) {
    return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={accentStyle.color} style={styles.loading} />;
  }
  const context = `album:${album.id}`;
  const discs = new Set(album.tracks.map(track => track.disc ?? 1)).size > 1;
  const credits = Object.entries(album.credits ?? {}).filter(([, values]) => values.length);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <CollectionHeader
        title={album.album}
        subtitle={album.artist}
        details={[album.type, album.year, `${album.tracks.length} songs`, longDuration(album.duration), album.quality?.label]
          .filter(Boolean).join(' · ')}
        albumId={album.artwork ? album.id : null}
        onPlay={() => player.playTracks(album.tracks, 0, context, false)}
        onShuffle={() => player.playTracks(album.tracks, Math.floor(Math.random() * album.tracks.length), context, true)}
        actions={[
          {label: album.liked ? '♥ Liked' : '♡ Like', active: album.liked, onPress: () =>
            api.setFavorite('album', [album.id], !album.liked).then(() => setData({...album, liked: !album.liked}))},
          {label: '↓ Download', onPress: () => downloads.enqueue(album.tracks).then(result =>
            Alert.alert('Downloads', result.blocked ?? `${result.queued} songs queued.`))},
          {label: 'Artist', onPress: () => go.artist(album.artist_id)},
          {label: 'Radio', onPress: () => api.radio('album', album.id).then(station => player.playTracks(station.tracks, 0, `radio:${album.id}`))},
        ]}
      />
      {album.tracks.map((track, index) => (
        <React.Fragment key={track.id}>
          {discs && (index === 0 || album.tracks[index - 1].disc !== track.disc) && (
            <Text style={[typography.label, styles.disc]}>Disc {track.disc ?? 1}</Text>
          )}
          <TrackRow track={track} showArtwork={false} onPress={() => player.playTracks(album.tracks, index, context, false)}
            onMore={() => setActions([track])} />
        </React.Fragment>
      ))}
      {credits.map(([role, values]) => (
        <Text key={role} style={[typography.caption, styles.credit]}>{role}: {values.join(', ')}</Text>
      ))}
      <Shelf title={`More by ${album.artist}`} items={(album.more_by_artist ?? []).map(other => ({
        key: other.id, title: other.album, subtitle: other.year ? String(other.year) : undefined,
        albumId: other.artwork ? other.id : null, onPress: () => go.album(other.id)}))} />
      <TrackActions tracks={actions} onClose={() => setActions(null)} />
      <FloatingPlayerSpacer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void},
  loading: {marginTop: spacing.xl},
  error: {color: colors.alert, padding: spacing.md},
  disc: {marginTop: spacing.md},
  credit: {marginTop: spacing.sm, textTransform: 'capitalize'},
});
