import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {SatellitesStackParamList} from '../../navigation/MainTabs';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {Track} from '../../media/types';
import {longDuration} from '../../media/format';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../../media/ui/TrackRow';
import {useLoad} from '../ui/useLoad';
import {CollectionHeader} from './CollectionHeader';
import {FloatingPlayerSpacer} from '../../components/FloatingPlayerInset';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'MusicPlaylist'>;

export function PlaylistScreen({route, navigation}: Props) {
  const accentStyle = useAccentStyles();
  const {api, player, downloads} = useMusic();
  const {data: playlist, error, reload, setData} = useLoad(() => api.playlist(route.params.id), [api, route.params.id]);
  const [actions, setActions] = useState<Track[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  if (!playlist) {
    return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={accentStyle.color} style={styles.loading} />;
  }
  const playable = playlist.tracks.filter(track => !track.missing);
  const context = `playlist:${playlist.id}`;

  const save = async () => {
    try {
      setData(await api.updatePlaylist(playlist.id, {name, description}));
      setEditing(false);
    } catch (failure: any) {
      Alert.alert('Playlist', failure?.message ?? 'Could not save.');
    }
  };

  const remove = () =>
    Alert.alert('Delete playlist', `Delete “${playlist.name}”? The songs stay in your library.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress: () => api.deletePlaylist(playlist.id).then(() => navigation.goBack())},
    ]);

  const move = async (entry: string | null | undefined, to: number) => {
    if (entry && to >= 0 && to < playlist.tracks.length) {
      setData(await api.moveInPlaylist(playlist.id, entry, to));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <CollectionHeader
        title={playlist.name}
        subtitle={playlist.description || undefined}
        details={`${playlist.smart ? 'Smart playlist · ' : ''}${playlist.track_count ?? playable.length} songs · ${longDuration(playlist.duration)}${
          playlist.unavailable ? ` · ${playlist.unavailable} unavailable` : ''}`}
        mosaic={playlist.mosaic}
        onPlay={() => player.playTracks(playable, 0, context, false)}
        onShuffle={() => player.playTracks(playable, Math.floor(Math.random() * playable.length), context, true)}
        actions={[
          ...(!playlist.smart ? [{label: 'Edit', onPress: () => { setName(playlist.name); setDescription(playlist.description); setEditing(true); }}] : []),
          {label: '↓ Download', onPress: () => downloads.enqueue(playable).then(result =>
            Alert.alert('Downloads', result.blocked ?? `${result.queued} songs queued.`))},
          {label: 'Delete', onPress: remove},
        ]}
      />
      {editing && (
        <View style={styles.editor}>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder="Name" placeholderTextColor={colors.textFaint} />
          <TextInput value={description} onChangeText={setDescription} style={styles.input} placeholder="Description"
            placeholderTextColor={colors.textFaint} multiline />
          <View style={styles.editorButtons}>
            <Pressable onPress={() => setEditing(false)}><Text style={[styles.link, accentStyle.text]}>Cancel</Text></Pressable>
            <Pressable onPress={save}><Text style={[styles.link, accentStyle.text]}>Save</Text></Pressable>
          </View>
        </View>
      )}
      {playlist.tracks.length === 0 && <Text style={typography.caption}>Add songs from any track's ⋮ menu.</Text>}
      {playlist.tracks.map((track, index) => (
        <View key={track.entry_id ?? `${track.id}-${index}`} style={styles.entry}>
          <View style={styles.entryRow}>
            <TrackRow track={track} onPress={() => player.playTracks(playable, Math.max(playable.indexOf(track), 0), context, false)}
              onMore={() => setActions([track])} />
          </View>
          {editing && !playlist.smart && (
            <View style={styles.order}>
              <Pressable onPress={() => move(track.entry_id, index - 1)} hitSlop={6}><Text style={styles.arrow}>▲</Text></Pressable>
              <Pressable onPress={() => move(track.entry_id, index + 1)} hitSlop={6}><Text style={styles.arrow}>▼</Text></Pressable>
            </View>
          )}
        </View>
      ))}
      <TrackActions tracks={actions} onClose={() => setActions(null)}
        playlistEntry={playlist.smart ? undefined : {playlistId: playlist.id, onRemoved: reload}} />
      <FloatingPlayerSpacer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120, backgroundColor: colors.void},
  loading: {marginTop: spacing.xl},
  error: {color: colors.alert, padding: spacing.md},
  editor: {gap: spacing.sm, marginBottom: spacing.md},
  input: {backgroundColor: colors.raised, color: colors.text, borderRadius: 999, paddingHorizontal: spacing.md},
  editorButtons: {flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg},
  link: {fontSize: 15},
  entry: {flexDirection: 'row', alignItems: 'center'},
  entryRow: {flex: 1},
  order: {paddingLeft: spacing.sm, gap: spacing.xs},
  arrow: {color: colors.textDim},
});
