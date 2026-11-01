import React, {useEffect, useReducer} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../../theme';
import {useMusic} from '../MusicProvider';
import {bytes} from '../ui/format';
import {TrackRow} from '../ui/TrackRow';

export function DownloadsScreen() {
  const {downloads, player, preferences} = useMusic();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => downloads.subscribe(refresh), [downloads]);
  useEffect(() => {
    downloads.ready().then(refresh);
  }, [downloads]);

  const entries = downloads.list();
  const tracks = entries.map(entry => entry.track);
  const limit = (preferences?.cache_limit_mb ?? 2048) * 1024 * 1024;

  return (
    <FlatList
      data={entries}
      keyExtractor={entry => entry.track.id}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <View style={styles.header}>
          {!downloads.supported && <Text style={styles.warning}>Downloads are only available in the Android app.</Text>}
          <Text style={typography.body}>{entries.length} songs · {bytes(downloads.usedBytes())} of {bytes(limit)}</Text>
          <Text style={typography.caption}>
            {preferences?.download_network === 'any' ? 'Downloads on any network' : 'Downloads on Wi-Fi only'} ·
            quality {preferences?.download_quality ?? 'original'} · oldest unplayed songs are removed past the limit
          </Text>
          {downloads.jobs.map(job => (
            <View key={job.id} style={styles.job}>
              <Text numberOfLines={1} style={[typography.body, styles.jobTitle]}>{job.track.title}</Text>
              <Text style={typography.caption}>
                {job.status === 'failed' ? job.error : job.total ? `${Math.round((job.received / job.total) * 100)}%` : job.status}
              </Text>
              <Pressable onPress={() => downloads.cancel(job.id)} hitSlop={8}><Text style={styles.link}>Cancel</Text></Pressable>
            </View>
          ))}
          {downloads.jobs.some(job => job.status === 'failed') && (
            <Pressable onPress={() => downloads.retryFailed()}><Text style={styles.link}>Retry failed downloads</Text></Pressable>
          )}
          {entries.length > 0 && (
            <View style={styles.actions}>
              <Pressable onPress={() => player.playTracks(tracks, 0, 'library:downloads')}><Text style={styles.link}>Play all</Text></Pressable>
              <Pressable onPress={() => Alert.alert('Remove downloads', 'Remove every downloaded song from this phone?', [
                {text: 'Cancel', style: 'cancel'},
                {text: 'Remove', style: 'destructive', onPress: () => downloads.removeAll()},
              ])}><Text style={styles.danger}>Remove all</Text></Pressable>
            </View>
          )}
        </View>
      }
      ListEmptyComponent={<Text style={typography.caption}>Download songs, albums or playlists to play them offline.</Text>}
      renderItem={({item, index}) => (
        <TrackRow track={item.track} subtitle={`${bytes(item.size)} · ${item.quality}`}
          onPress={() => player.playTracks(tracks, index, 'library:downloads')}
          onMore={() => downloads.remove(item.track.id)} />
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void},
  header: {gap: spacing.sm, marginBottom: spacing.md},
  warning: {color: colors.alert},
  job: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  jobTitle: {flex: 1},
  actions: {flexDirection: 'row', gap: spacing.lg},
  link: {color: colors.azure},
  danger: {color: colors.alert},
});
