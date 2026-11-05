import {useIsFocused} from '@react-navigation/native';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View} from 'react-native';
import {colors, tokens, useAccent} from '../../theme';
import {usePlayerState} from '../AudioHost';
import {Artwork} from './Artwork';
import {anchors, Rect, setPlayerCollapsed, usePlayerCollapsed} from './dock';

const SIZE = 36;

function useSpin(playing: boolean) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!playing) {
      return;
    }
    let stopped = false;
    const turn = () => {
      spin.setValue(0);
      Animated.timing(spin, {toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true}).start(
        ({finished}) => finished && !stopped && turn(),
      );
    };
    turn();
    return () => {
      stopped = true;
      spin.stopAnimation();
    };
  }, [playing, spin]);
  return spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
}

/** The playing cover as a spinning disc, in the header's top-bar slot (see TopBarSlot).
 * Tapping it brings the mini-player up or puts it away. */
export function AudioDisc() {
  const {color: accent} = useAccent();
  const state = usePlayerState();
  const collapsed = usePlayerCollapsed();
  const focused = useIsFocused();
  const ref = useRef<View>(null);
  const track = state.track;
  const playing = state.remote ? !!state.remote.state?.playing : state.playing;
  const rotate = useSpin(playing);
  const flying = useFlying();

  // the disc of the screen on show is where the cover flies from and back to
  const measure = useCallback(() => {
    if (focused) {
      ref.current?.measureInWindow((x, y, width, height) => width && (anchors.disc = {x, y, width, height}));
    }
  }, [focused]);
  useEffect(measure, [measure, track]);

  if (!track) {
    return null;
  }
  return (
    <Pressable
      ref={ref}
      onLayout={measure}
      onPress={() => {
        measure();
        setPlayerCollapsed(!collapsed);
      }}
      accessibilityRole="button"
      accessibilityLabel={collapsed ? 'Show the player' : 'Put the player away'}
      accessibilityState={{expanded: !collapsed}}
      testID="music-disc"
      hitSlop={4}
      style={[styles.disc, !collapsed && {borderColor: accent}]}>
      <Animated.View style={[styles.art, {opacity: flying ? 0 : collapsed ? 1 : 0.55, transform: [{rotate}]}]}>
        <Artwork albumId={track.has_artwork ? track.album_id : null} size={SIZE} round label={track.title} />
      </Animated.View>
      <View style={styles.hole} />
    </Pressable>
  );
}

// whether the cover is in flight, so the disc hides its own copy meanwhile
let flyingNow = false;
const flyingListeners = new Set<(value: boolean) => void>();
function setFlyingNow(value: boolean) {
  flyingNow = value;
  flyingListeners.forEach(listener => listener(value));
}
function useFlying() {
  const [value, setValue] = useState(flyingNow);
  useEffect(() => {
    flyingListeners.add(setValue);
    return () => {
      flyingListeners.delete(setValue);
    };
  }, []);
  return value;
}

/** The cover's flight between the disc and the mini-player: down and larger as the bar rises,
 * back up and spinning as it sinks. Drawn once, above the navigation; it measures where both
 * ends are, and skips the flight when either is unknown or motion is reduced. */
export function AudioFlight() {
  const state = usePlayerState();
  const collapsed = usePlayerCollapsed();
  const origin = useRef<View>(null);
  const flight = useRef(new Animated.Value(0)).current;
  const [path, setPath] = useState<null | {from: Rect; to: Rect; down: boolean}>(null);
  const first = useRef(true);
  const track = state.track;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const {disc, cover} = anchors;
    if (!track || !disc || !cover) {
      return;
    }
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then(reduced => {
        if (cancelled || reduced) {
          return;
        }
        origin.current?.measureInWindow((ox, oy) => {
          if (cancelled) {
            return;
          }
          const local = (rect: Rect) => ({...rect, x: rect.x - ox, y: rect.y - oy});
          const down = !collapsed;
          setPath({from: local(disc), to: local(cover), down});
          setFlyingNow(true);
          flight.setValue(down ? 0 : 1);
          Animated.timing(flight, {
            toValue: down ? 1 : 0,
            duration: down ? 520 : 420,
            easing: Easing.bezier(0.2, 0.8, 0.2, 1),
            useNativeDriver: true,
          }).start(() => {
            setPath(null);
            setFlyingNow(false);
          });
        });
      });
    return () => {
      cancelled = true;
    };
    // the flight follows the collapsed state only; the track is read as it is then
  }, [collapsed, flight]);

  return (
    <View ref={origin} pointerEvents="none" style={StyleSheet.absoluteFill} collapsable={false}>
      {path && track && (
        <Animated.View
          style={[
            styles.ghost,
            {
              left: path.from.x + (path.from.width - SIZE) / 2,
              top: path.from.y + (path.from.height - SIZE) / 2,
              opacity: flight.interpolate({inputRange: [0, 0.85, 1], outputRange: [1, 1, 0]}),
              transform: [
                {translateX: flight.interpolate({inputRange: [0, 1], outputRange: [0, path.to.x + path.to.width / 2 - (path.from.x + path.from.width / 2)]})},
                {translateY: flight.interpolate({inputRange: [0, 1], outputRange: [0, path.to.y + path.to.height / 2 - (path.from.y + path.from.height / 2)]})},
                {scale: flight.interpolate({inputRange: [0, 0.5, 1], outputRange: [1, 1.8, path.to.width / SIZE]})},
                {rotate: flight.interpolate({inputRange: [0, 1], outputRange: ['0deg', path.down ? '-360deg' : '360deg']})},
              ],
            },
          ]}>
          <Artwork albumId={track.has_artwork ? track.album_id : null} size={SIZE} round label={track.title} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    width: SIZE + 4,
    height: SIZE + 4,
    borderRadius: (SIZE + 4) / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  art: {width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: 'hidden'},
  // the spindle hole with a hairline groove: the one nod to a record
  hole: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.palette.bg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  ghost: {position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: 'hidden', elevation: 8},
});
