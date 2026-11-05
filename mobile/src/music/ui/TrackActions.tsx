import React, {useEffect, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {ModalSafeArea} from '../../components/ModalSafeArea';
import {colors, radius, spacing, TOUCH_TARGET, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {Playlist, Track} from '../../media/types';
import {useMusicNavigation} from './navigation';

/** The long-press sheet for one or more tracks. */
export function TrackActions({tracks, onClose, playlistEntry}: {
  tracks: Track[] | null;
  onClose: () => void;
  playlistEntry?: {playlistId: string; onRemoved: () => void};
}) {
  const {player, api, liked, setLiked, downloads} = useMusic();
  const go = useMusicNavigation();
  const [picking, setPicking] = useState(false);
  const track = tracks?.[0];
  if (!tracks || !track) {
    return null;
  }
  const allLiked = tracks.every(item => liked.has(item.id));
  const run = (action: () => unknown) => () => {
    Promise.resolve(action()).catch((error: any) => Alert.alert('Music', error?.message ?? 'That did not work.'));
    onClose();
  };
  const items: [string, () => unknown][] = [
    ['Play next', () => player.playNext(tracks)],
    ['Add to queue', () => player.append(tracks)],
    ['Add to playlist…', () => setPicking(true)],
    [allLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs', () => setLiked(tracks.map(item => item.id), !allLiked)],
    [
      tracks.every(item => downloads.isDownloaded(item.id)) ? 'Remove download' : 'Download',
      async () => {
        if (tracks.every(item => downloads.isDownloaded(item.id))) {
          for (const item of tracks) {
            await downloads.remove(item.id);
          }
          return;
        }
        const result = await downloads.enqueue(tracks);
        if (result.blocked) {
          Alert.alert('Downloads', result.blocked);
        }
      },
    ],
  ];
  if (tracks.length === 1) {
    items.push(['Start radio', async () => {
      const station = await api.radio('track', track.id);
      await player.playTracks(station.tracks, 0, `radio:${track.id}`);
    }]);
    items.push(['Go to album', () => go.album(track.album_id)]);
    items.push(['Go to artist', () => go.artist(track.artist_id)]);
  }
  if (playlistEntry && track.entry_id) {
    items.push(['Remove from this playlist', async () => {
      await api.removeFromPlaylist(playlistEntry.playlistId, tracks.map(item => item.entry_id!).filter(Boolean));
      playlistEntry.onRemoved();
    }]);
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <ModalSafeArea>
        <Sheet onClose={onClose}>
          {picking ? (
            <PlaylistPicker tracks={tracks} onDone={onClose} />
          ) : (
            <>
              <Text numberOfLines={1} style={typography.heading}>
                {tracks.length > 1 ? `${tracks.length} songs` : track.title}
              </Text>
              {items.map(([label, action]) => (
                <Pressable key={label} onPress={label.startsWith('Add to playlist') ? () => setPicking(true) : run(action)}
                  accessibilityRole="button" style={styles.item}>
                  <Text style={typography.body}>{label}</Text>
                </Pressable>
              ))}
            </>
          )}
        </Sheet>
      </ModalSafeArea>
    </Modal>
  );
}

/** The bottom sheet: clear of the status bar above it and the gesture bar below it. */
function Sheet({children, onClose}: {children: React.ReactNode; onClose: () => void}) {
  const insets = useSafeAreaInsets();
  return (
    <Pressable style={[styles.backdrop, {paddingTop: insets.top}]} onPress={onClose}>
      <Pressable style={[styles.sheet, {paddingBottom: spacing.lg + insets.bottom}]} onPress={() => undefined}>
        {children}
      </Pressable>
    </Pressable>
  );
}

function PlaylistPicker({tracks, onDone}: {tracks: Track[]; onDone: () => void}) {
  const accentStyle = useAccentStyles();
  const {api} = useMusic();
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    api.playlists().then(list => setPlaylists(list.filter(item => !item.smart))).catch(() => setPlaylists([]));
  }, [api]);

  const add = async (playlist: Playlist) => {
    try {
      const result = await api.addToPlaylist(playlist.id, tracks.map(track => track.id));
      if (result.duplicates.length && !result.added) {
        Alert.alert(playlist.name, 'Already in this playlist.');
      } else if (result.duplicates.length) {
        Alert.alert(playlist.name, `Added ${result.added}; ${result.duplicates.length} already there were skipped.`);
      }
    } catch (error: any) {
      Alert.alert('Playlist', error?.message ?? 'Could not add.');
    }
    onDone();
  };

  const create = async () => {
    if (!name.trim()) {
      return;
    }
    await api.createPlaylist(name.trim(), tracks.map(track => track.id)).catch((error: any) =>
      Alert.alert('Playlist', error?.message ?? 'Could not create.'));
    onDone();
  };

  return (
    <View>
      <Text style={typography.heading}>Add to playlist</Text>
      <View style={styles.createRow}>
        <TextInput value={name} onChangeText={setName} placeholder="New playlist" placeholderTextColor={colors.textFaint}
          style={styles.input} onSubmitEditing={create} />
        <Pressable onPress={create} style={[styles.createButton, accentStyle.fill]}>
          <Text style={[styles.createLabel, accentStyle.onFill]}>Create</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list}>
        {(playlists ?? []).map(playlist => (
          <Pressable key={playlist.id} onPress={() => add(playlist)} style={styles.item}>
            <Text style={typography.body}>{playlist.name}</Text>
          </Pressable>
        ))}
        {playlists?.length === 0 && <Text style={typography.caption}>No playlists yet.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg},
  item: {minHeight: TOUCH_TARGET, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line},
  createRow: {flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.md},
  input: {flex: 1, minHeight: TOUCH_TARGET, color: colors.text, backgroundColor: colors.raised, borderRadius: 999, paddingHorizontal: spacing.md},
  createButton: {borderRadius: 999, paddingHorizontal: spacing.md, minHeight: TOUCH_TARGET, justifyContent: 'center'},
  createLabel: {color: colors.onAccent, fontWeight: '700'},
  list: {maxHeight: 320},
});
