import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withTiming} from 'react-native-reanimated';

/** How far a pinch or a double tap zooms in. */
export const MAX_ZOOM = 5;
export const DOUBLE_TAP_ZOOM = 2.5;

/** How far an image scaled by `scale` inside a `size` frame may move before showing its edge. */
export function panLimit(size: number, scale: number): number {
  'worklet';
  return Math.max(0, (size * (scale - 1)) / 2);
}

function clamp(value: number, limit: number): number {
  'worklet';
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * A still image that pinches to zoom (1x-5x) and, zoomed in, pans - shared by Photo's own
 * viewer and the UI contract's media viewer, so both feel the same. Releasing below the
 * original size springs back; leaving the page (`active` false) resets it.
 *
 * Swiping between items belongs to the pager the image sits in, never to this view:
 * - without `onZoomChange`, a zoomed image pans with two fingers only, so one finger always
 *   swipes (Photo's own viewer, whose pager can't be paused);
 * - with it, the pager hears when the image is zoomed and pauses its own swiping, and a
 *   zoomed image pans with one finger and zooms in or out on a double tap.
 */
export function ZoomableImage({
  source, active = true, onZoomChange, onLoadEnd, onError, style, accessibilityLabel,
}: {
  source: {uri: string; headers?: Record<string, string>};
  active?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
  onLoadEnd?: () => void;
  onError?: () => void;
  style?: any;
  accessibilityLabel?: string;
}) {
  const [frame, setFrame] = useState({width: 0, height: 0});
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const paging = Boolean(onZoomChange);
  // a one-finger pan only exists while zoomed: unzoomed, that finger swipes the pager
  const [zoomed, setZoomed] = useState(false);

  const report = (value: boolean) => {
    setZoomed(value);
    onZoomChange?.(value);
  };

  const reset = (animated: boolean) => {
    'worklet';
    scale.value = animated ? withTiming(1) : 1;
    x.value = animated ? withTiming(0) : 0;
    y.value = animated ? withTiming(0) : 0;
    savedScale.value = 1;
    savedX.value = 0;
    savedY.value = 0;
  };

  // another item is showing: this one is back to its own size when it returns
  useEffect(() => {
    if (!active) {
      reset(false);
      report(false);
    }
    // only when the page stops being the one shown
  }, [active]);

  const hold = (value: boolean) => onZoomChange?.(value);

  const pinch = Gesture.Pinch()
    // a second finger on the image: the pager stops at once, before it can take the pinch for a
    // sideways swipe; it starts again when the fingers lift with the image back to its size
    .onTouchesDown(event => {
      if (event.numberOfTouches >= 2) {
        runOnJS(hold)(true);
      }
    })
    .onFinalize(() => {
      // the scale it settles at, not the one on screen: a double tap's way back to 1x is
      // still animating here
      runOnJS(report)(savedScale.value > 1.01);
    })
    .onUpdate(event => {
      scale.value = Math.min(MAX_ZOOM, Math.max(1, savedScale.value * event.scale));
      x.value = clamp(savedX.value, panLimit(width.value, scale.value));
      y.value = clamp(savedY.value, panLimit(height.value, scale.value));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedX.value = x.value;
      savedY.value = y.value;
      if (scale.value <= 1.01) {
        reset(true);
      }
      runOnJS(report)(scale.value > 1.01);
    });

  const pan = Gesture.Pan()
    .minPointers(paging ? 1 : 2)
    .enabled(!paging || zoomed)
    .onUpdate(event => {
      if (scale.value <= 1) {
        return;
      }
      x.value = clamp(savedX.value + event.translationX, panLimit(width.value, scale.value));
      y.value = clamp(savedY.value + event.translationY, panLimit(height.value, scale.value));
    })
    .onEnd(() => {
      savedX.value = x.value;
      savedY.value = y.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    // a finger that moves is a pan, not a tap: fail at once, so the pan starts without waiting
    .maxDistance(12)
    .enabled(paging)
    .onEnd(() => {
      if (scale.value > 1.01) {
        reset(true);
        runOnJS(report)(false);
      } else {
        scale.value = withTiming(DOUBLE_TAP_ZOOM);
        savedScale.value = DOUBLE_TAP_ZOOM;
        runOnJS(report)(true);
      }
    });

  const gesture = Gesture.Simultaneous(pinch, paging ? Gesture.Exclusive(doubleTap, pan) : pan);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: x.value}, {translateY: y.value}, {scale: scale.value}],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.frame, style]}
        collapsable={false}
        onLayout={event => {
          const {width: w, height: h} = event.nativeEvent.layout;
          width.value = w;
          height.value = h;
          setFrame({width: w, height: h});
        }}>
        <Animated.View style={[styles.fill, animatedStyle]}>
          <Image
            source={source}
            style={frame.width ? {width: frame.width, height: frame.height} : styles.fill}
            resizeMode="contain"
            onLoadEnd={onLoadEnd}
            onError={onError}
            accessibilityLabel={accessibilityLabel}
            accessibilityIgnoresInvertColors
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: {flex: 1, alignSelf: 'stretch', overflow: 'hidden'},
  fill: {flex: 1},
});
