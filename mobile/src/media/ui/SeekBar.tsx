import React, {useMemo, useRef, useState} from 'react';
import {LayoutChangeEvent, PanResponder, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../../theme';
import {duration as format} from '../format';

export function SeekBar({position, duration, onSeek}: {position: number; duration: number; onSeek: (seconds: number) => void}) {
  const [width, setWidth] = useState(1);
  const [dragging, setDragging] = useState<number | null>(null);
  const state = useRef({width: 1, duration: 0, onSeek});
  state.current = {width, duration, onSeek};

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: event => setDragging(ratio(event.nativeEvent.locationX)),
        onPanResponderMove: event => setDragging(ratio(event.nativeEvent.locationX)),
        onPanResponderRelease: event => {
          const value = ratio(event.nativeEvent.locationX);
          setDragging(null);
          state.current.onSeek(value * state.current.duration);
        },
        onPanResponderTerminate: () => setDragging(null),
      }),
    [],
  );

  function ratio(x: number) {
    return Math.max(0, Math.min(1, x / state.current.width));
  }

  const progress = dragging ?? (duration > 0 ? Math.min(position / duration, 1) : 0);
  return (
    <View>
      <View style={styles.hit} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width || 1)}
        {...responder.panHandlers} accessibilityRole="adjustable" accessibilityLabel="Seek"
        accessibilityValue={{min: 0, max: Math.round(duration), now: Math.round(position)}}>
        <View style={styles.track} pointerEvents="none">
          <View style={[styles.fill, {width: `${progress * 100}%`}]} />
        </View>
        <View pointerEvents="none" style={[styles.thumb, {left: `${progress * 100}%`}]} />
      </View>
      <View style={styles.times}>
        <Text style={typography.label}>{format(dragging !== null ? dragging * duration : position)}</Text>
        <Text style={typography.label}>-{format(Math.max(duration - (dragging !== null ? dragging * duration : position), 0))}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hit: {height: 28, justifyContent: 'center'},
  track: {height: 4, borderRadius: 2, backgroundColor: colors.lineBright, overflow: 'hidden'},
  fill: {height: 4, backgroundColor: colors.text},
  thumb: {position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: colors.text},
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs},
});
