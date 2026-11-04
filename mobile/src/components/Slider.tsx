import React, {useEffect, useMemo, useRef, useState} from 'react';
import {LayoutChangeEvent, PanResponder, StyleSheet, View} from 'react-native';
import {tokens, useAccent} from '../theme';

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** while dragging, for a live readout */
  onChange?: (value: number) => void;
  /** once, when the finger lifts (or an accessibility step) - when to act */
  onComplete: (value: number) => void;
  onDragStateChange?: (dragging: boolean) => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}

export function snap(raw: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, raw));
  const steps = Math.round((clamped - min) / step);
  // trimmed so 0.1-steps don't come back as 0.30000000000000004
  return Math.min(max, Number((min + steps * step).toFixed(6)));
}

/** StarCore's one slider: a track in the accent colour and a white thumb,
 * driven by React Native's own PanResponder (no native dependency), and
 * adjustable by accessibility actions one step at a time. */
export function Slider({value, min, max, step = 1, onChange, onComplete, onDragStateChange, accessibilityLabel, disabled}: Props) {
  const {color: accent} = useAccent();
  const [width, setWidth] = useState(0);
  const [shown, setShown] = useState(value);
  const dragging = useRef(false);
  const startX = useRef(0);
  const latest = useRef({width, min, max, step, onChange, onComplete, onDragStateChange, disabled});
  latest.current = {width, min, max, step, onChange, onComplete, onDragStateChange, disabled};

  useEffect(() => {
    if (!dragging.current) {
      setShown(value);
    }
  }, [value]);

  const responder = useMemo(() => {
    const valueAt = (x: number) => {
      const {width: w, min: lo, max: hi, step: s} = latest.current;
      return snap(lo + (w > 0 ? x / w : 0) * (hi - lo), lo, hi, s);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      // a vertical scroll mustn't steal a drag that already started here
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: event => {
        dragging.current = true;
        latest.current.onDragStateChange?.(true);
        startX.current = event.nativeEvent.locationX;
        const next = valueAt(startX.current);
        setShown(next);
        latest.current.onChange?.(next);
      },
      onPanResponderMove: (_, gesture) => {
        const next = valueAt(startX.current + gesture.dx);
        setShown(next);
        latest.current.onChange?.(next);
      },
      onPanResponderRelease: (_, gesture) => {
        const next = valueAt(startX.current + gesture.dx);
        dragging.current = false;
        latest.current.onDragStateChange?.(false);
        setShown(next);
        latest.current.onComplete(next);
      },
      onPanResponderTerminate: () => {
        dragging.current = false;
        latest.current.onDragStateChange?.(false);
      },
    });
  }, []);

  const ratio = max > min ? (Math.min(max, Math.max(min, shown)) - min) / (max - min) : 0;
  const stepBy = (direction: 1 | -1) => {
    const next = snap(shown + direction * step, min, max, step);
    setShown(next);
    onComplete(next);
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{disabled: !!disabled}}
      accessibilityValue={{min, max, now: shown}}
      accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
      onAccessibilityAction={event => stepBy(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.hit, disabled && styles.disabled]}
      {...responder.panHandlers}>
      <View style={styles.track} pointerEvents="none">
        <View style={[styles.fill, {width: `${ratio * 100}%`, backgroundColor: accent}]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, {left: Math.min(Math.max(0, width - THUMB), Math.max(0, ratio * width - THUMB / 2))}]} />
    </View>
  );
}

const THUMB = 22;

const styles = StyleSheet.create({
  // 44dp tall so the whole row is an easy target, not just the thin track
  hit: {height: 44, justifyContent: 'center'},
  track: {height: 6, borderRadius: 3, backgroundColor: tokens.palette.controlStrong, overflow: 'hidden'},
  fill: {height: 6},
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: tokens.palette.text,
    top: (44 - THUMB) / 2,
  },
  disabled: {opacity: 0.5},
});
