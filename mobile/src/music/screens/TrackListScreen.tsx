import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, FlatList, StyleSheet, Text} from 'react-native';
import type {SatellitesStackParamList} from '../../navigation/MainTabs';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import type {MusicApi} from '../api';
import {useMusic} from '../MusicProvider';
import type {Track} from '../types';
import {TrackListKind} from '../ui/navigation';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../ui/TrackRow';
import {useLoad} from '../ui/useLoad';
import {CollectionHeader} from './CollectionHeader';
import {FloatingPlayerSpacer} from '../../components/FloatingPlayerInset';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'MusicTracks'>;

async function load(api: MusicApi, kind: TrackListKind, id: string): Promise<{tracks: Track[]; description?: string; mosaic?: string[]}> {
  switch (kind) {
    case 'mix':
      return api.mix(id);
    case 'radio':
      return api.radio('track', id);
    case 'mood':
      return api.mood(id);
    case 'liked':
      return {tracks: (await api.favorites()).tracks};
    case 'recent':
      return api.history(100);
    case 'genre':
      return {tracks: await api.tracks(`?genre=${encodeURIComponent(id)}&sort=random&limit=200`)};
  }
}

/** Any generated or derived list of songs: a mix, a radio, a mood, liked songs, history, a genre. */
export function TrackListScreen({route, navigation}: Props) {
  const accentStyle = useAccentStyles();
  const {api, player} = useMusic();
  const {kind, id, title} = route.params;
  const {data, error} = useLoad(() => load(api, kind, id), [api, kind, id]);
  const [actions, setActions] = useState<Track[] | null>(null);

  useEffect(() => {
    navigation.setOptions({title});
  }, [navigation, title]);

  if (!data) {
    return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={accentStyle.color} style={styles.loading} />;
  }
  const context = kind === 'mix' ? `mix:${id}` : kind === 'liked' ? 'liked:' : kind === 'genre' ? `genre:${id.slice(0, 60).replace(/[^\w.-]/g, '-')}` : `queue:${kind}`;
  return (
    <FlatList
      data={data.tracks}
      keyExtractor={(track, index) => `${track.id}-${index}`}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <CollectionHeader title={title} details={data.description ?? `${data.tracks.length} songs`} mosaic={data.mosaic}
          onPlay={() => player.playTracks(data.tracks, 0, context, false)}
          onShuffle={() => player.playTracks(data.tracks, Math.floor(Math.random() * data.tracks.length), context, true)} />
      }
      ListEmptyComponent={<Text style={typography.caption}>Nothing here yet - play some music and come back.</Text>}
      ListFooterComponent={<><TrackActions tracks={actions} onClose={() => setActions(null)} /><FloatingPlayerSpacer /></>}
      renderItem={({item, index}) => (
        <TrackRow track={item} onPress={() => player.playTracks(data.tracks, index, context, false)} onMore={() => setActions([item])} />
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void},
  loading: {marginTop: spacing.xl},
  error: {color: colors.alert, padding: spacing.md},
});
