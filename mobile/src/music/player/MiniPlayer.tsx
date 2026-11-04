import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {colors, spacing, typography, useAccent} from '../../theme';
import {useMusic, usePlayerState} from '../MusicProvider';
import {Artwork} from '../ui/Artwork';
import {anchors, setPlayerCollapsed, usePlayerCollapsed} from './dock';

/** A floating bubble above the tab bar on every tab; tap or swipe up opens the full player.
 * The chevron (or a swipe down) puts it away into the top-right disc, which brings it back. */
export function MiniPlayer() {
  const {color: accent, onColor} = useAccent();
  const {player, setFullPlayer, liked, setLiked} = useMusic();
  const state = usePlayerState();
  const collapsed = usePlayerCollapsed();
  const track = state.track;
  const open = Boolean(track) && !collapsed;
  // stays drawn while it sinks away, so the retract plays before it unmounts
  const [drawn, setDrawn] = useState(open);
  const shown = useRef(new Animated.Value(open ? 1 : 0)).current;
  const cover = useRef<View>(null);
  useEffect(() => {
    if (open) {
      setDrawn(true);
    }
    Animated.timing(shown, {
      toValue: open ? 1 : 0,
      duration: open ? 380 : 260,
      delay: open ? 80 : 0,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({finished}) => finished && !open && setDrawn(false));
  }, [open, shown]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 12 && Math.abs(gesture.dx) < 30,
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy < -30) {
            setFullPlayer(true);
          } else if (gesture.dy > 30) {
            setPlayerCollapsed(true);
          }
        },
      }),
    [setFullPlayer],
  );
  if (!track || !(drawn || open)) {
    return null;
  }
  const progress = state.duration ? Math.min(state.position / state.duration, 1) : 0;
  const playing = state.remote ? !!state.remote.state?.playing : state.playing;
  const isLiked = liked.has(track.id);
  const motion = {
    opacity: shown,
    transform: [{translateY: shown.interpolate({inputRange: [0, 1], outputRange: [96, 0]})}],
  };
  return (
    <Animated.View style={[styles.wrapper, motion]} {...responder.panHandlers} testID="music-mini-player">
      <Pressable style={styles.bar} onPress={() => setFullPlayer(true)} accessibilityLabel="Open the player">
        <View
          ref={cover}
          collapsable={false}
          onLayout={() =>
            // where the disc's cover lands; measured once the bar has risen into place
            setTimeout(() => cover.current?.measureInWindow((x, y, width, height) => width && (anchors.cover = {x, y, width, height})), 500)
          }>
          <Artwork albumId={track.has_artwork ? track.album_id : null} size={44} label={track.title} />
        </View>
        <View style={styles.text}>
          <Text numberOfLines={1} style={styles.title}>{track.title}</Text>
          <Text numberOfLines={1} style={typography.caption}>
            {state.remote ? `Playing on ${state.remote.name}` : state.error ? state.error : track.artist ?? track.album_artist}
          </Text>
        </View>
        <Pressable
          onPress={() => setLiked([track.id], !isLiked)}
          style={[styles.pill, isLiked && {backgroundColor: `${accent}29`}]}
          accessibilityRole="button"
          accessibilityLabel="Like"
          accessibilityState={{selected: isLiked}}>
          <Text style={[styles.icon, isLiked && {color: accent}]}>{isLiked ? '♥' : '♡'}</Text>
        </Pressable>
        {state.buffering && state.playing ? (
          <View style={[styles.play, {backgroundColor: accent}]}>
            <ActivityIndicator color={onColor} />
          </View>
        ) : (
          <Pressable
            onPress={() => player.toggle()}
            style={[styles.play, {backgroundColor: accent}]}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={18} color={onColor} />
          </Pressable>
        )}
        <Pressable
          onPress={() => setPlayerCollapsed(true)}
          style={styles.pill}
          accessibilityRole="button"
          accessibilityLabel="Put the player away"
          testID="music-player-retract">
          <Icon name="chevron-down" size={18} color={colors.textDim} />
        </Pressable>
      </Pressable>
      <View style={styles.progress}>
        <View style={[styles.fill, {backgroundColor: accent, width: `${progress * 100}%`}]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // a bubble with room around it, as on the web
  wrapper: {
    marginHorizontal: spacing.sm + 4,
    marginBottom: spacing.sm,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    elevation: 6,
  },
  bar: {flexDirection: 'row', alignItems: 'center', padding: spacing.sm, gap: spacing.sm},
  text: {flex: 1},
  title: {...typography.body, fontWeight: '600'},
  icon: {color: colors.text, fontSize: 18},
  pill: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised},
  play: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center'},
  progress: {height: 2, marginHorizontal: 20, marginBottom: 6, borderRadius: 1, backgroundColor: colors.line, overflow: 'hidden'},
  fill: {height: 2},
});
