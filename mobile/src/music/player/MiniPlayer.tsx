import React, {useMemo} from 'react';
import {ActivityIndicator, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, radius, spacing, touchTarget, typography} from '../../theme';
import {useMusic, usePlayerState} from '../MusicProvider';
import {Artwork} from '../ui/Artwork';

/** Sits above the tab bar on every tab; tap or swipe up opens the full player. */
export function MiniPlayer() {
  const {player, setFullPlayer, liked, setLiked} = useMusic();
  const state = usePlayerState();
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => gesture.dy < -12 && Math.abs(gesture.dx) < 30,
        onPanResponderRelease: (_, gesture) => gesture.dy < -30 && setFullPlayer(true),
      }),
    [setFullPlayer],
  );
  const track = state.track;
  if (!track) {
    return null;
  }
  const progress = state.duration ? Math.min(state.position / state.duration, 1) : 0;
  const playing = state.remote ? !!state.remote.state?.playing : state.playing;
  return (
    <View style={styles.wrapper} {...responder.panHandlers}>
      <Pressable style={styles.bar} onPress={() => setFullPlayer(true)} accessibilityLabel="Open the player">
        <Artwork albumId={track.has_artwork ? track.album_id : null} size={40} label={track.title} />
        <View style={styles.text}>
          <Text numberOfLines={1} style={styles.title}>{track.title}</Text>
          <Text numberOfLines={1} style={typography.caption}>
            {state.remote ? `Playing on ${state.remote.name}` : state.error ? state.error : track.artist ?? track.album_artist}
          </Text>
        </View>
        <Pressable onPress={() => setLiked([track.id], !liked.has(track.id))} style={styles.touch} accessibilityRole="button" accessibilityLabel="Like">
          <Text style={[styles.icon, liked.has(track.id) && styles.liked]}>{liked.has(track.id) ? '♥' : '♡'}</Text>
        </Pressable>
        {state.buffering && state.playing ? (
          <ActivityIndicator color={colors.text} style={styles.control} />
        ) : (
          <Pressable onPress={() => player.toggle()} style={styles.touch} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'}>
            <Text style={styles.icon}>{playing ? '❚❚' : '▶'}</Text>
          </Pressable>
        )}
      </Pressable>
      <View style={styles.progress}>
        <View style={[styles.fill, {width: `${progress * 100}%`}]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {marginHorizontal: spacing.sm, marginBottom: spacing.xs, borderRadius: radius.md, backgroundColor: colors.raised, overflow: 'hidden'},
  bar: {flexDirection: 'row', alignItems: 'center', padding: spacing.sm, gap: spacing.sm},
  text: {flex: 1},
  title: {...typography.body, fontWeight: '600'},
  icon: {color: colors.text, fontSize: 20, paddingHorizontal: spacing.xs},
  liked: {color: colors.azure},
  control: {width: 48, alignItems: 'center'},
  touch: touchTarget,
  progress: {height: 2, backgroundColor: colors.line},
  fill: {height: 2, backgroundColor: colors.azure},
});
