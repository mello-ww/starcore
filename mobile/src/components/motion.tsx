import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, LayoutChangeEvent, LayoutRectangle, StyleProp, ViewStyle} from 'react-native';
import {useAccent} from '../theme';

/**
 * The app's shared motion: restrained, short, and none at all when the system asks for reduced
 * motion. Every animated shared component takes its timing and that setting from here.
 */
export const MOTION = {
  /** a selection moving between neighbours */
  move: 220,
  /** something appearing in place (a panel opening) */
  enter: 180,
};

const ease = Easing.bezier(0.2, 0.8, 0.2, 1);

/** Whether the system asks for reduced motion, kept current while the screen is open. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then(value => active && setReduced(Boolean(value)))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', value => setReduced(Boolean(value)));
    return () => {
      active = false;
      subscription?.remove?.();
    };
  }, []);
  return reduced;
}

/**
 * A selector that slides between the options of a row (pill tabs, segments, a select's
 * options), instead of the accent jumping from one to the next.
 *
 * Each option passes `onItemLayout(index)` as its `onLayout` and takes `selectedBackground(active)`
 * for its background, and the row draws `indicator` as its first child: an accent pill behind
 * the selected option that follows it. Until the indicator has its place the selected option
 * paints its own accent, so the selection never blinks out. Nothing is selected when `selected`
 * is negative. A re-layout and reduced motion move it without animating.
 *
 * A row that is drawn again when its selection changes (a page that reloads, another page of
 * the same document) passes `remember`, a key naming the row: the indicator then starts where
 * that row last had it and slides from there.
 *
 * A row whose options have a background of their own passes it as `track`, and each option
 * passes its index to `selectedBackground`: the row then draws those backgrounds itself, under
 * the indicator, so the accent stays in sight while it passes the other options instead of
 * slipping behind them.
 */
export function useSlidingSelection(
  selected: number,
  {
    radius = 999,
    style,
    remember,
    track,
  }: {radius?: number; style?: StyleProp<ViewStyle>; remember?: string; track?: string} = {},
) {
  const {color: accent} = useAccent();
  const reduced = useReducedMotion();
  const frames = useRef<Record<number, LayoutRectangle>>({});
  const values = useRef({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    width: new Animated.Value(0),
    height: new Animated.Value(0),
  }).current;
  const [placed, setPlaced] = useState(false);
  const current = useRef(selected);
  current.current = selected;
  const placedRef = useRef(false);
  const shown = useRef<Place | null>(null);
  const moving = useRef(false);
  // the options' frames as drawn, for the track under the indicator
  const [laid, setLaid] = useState<Record<number, LayoutRectangle>>({});

  const place = useCallback(
    (animated: boolean) => {
      let animate = animated;
      const frame = frames.current[current.current];
      if (!frame) {
        return;
      }
      const target: Place = {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
      const keys = Object.keys(target) as (keyof Place)[];
      const before = !placedRef.current && remember ? lastPlaces.get(remember) : undefined;
      // drawn again for a new selection (perhaps more than once while the page loads): start
      // from where this row's accent last came to rest, since an interrupted move was not seen
      const rest = before?.settled;
      if (rest && !reduced && (rest.x !== target.x || rest.y !== target.y)) {
        keys.forEach(key => values[key].setValue(rest[key]));
        shown.current = rest;
        placedRef.current = true;
        setPlaced(true);
        animate = true;
      }
      const from = animate && !reduced && placedRef.current && shown.current ? shown.current : target;
      shown.current = target;
      const move = {settled: from === target ? target : before?.settled ?? from};
      if (remember) {
        lastPlaces.set(remember, move);
      }
      if (from === target) {
        moving.current = false;
        keys.forEach(key => {
          values[key].stopAnimation();
          values[key].setValue(target[key]);
        });
        if (!placedRef.current) {
          placedRef.current = true;
          setPlaced(true);
        }
        return;
      }
      // the position moves on the native thread, so a page loading at the same moment cannot
      // stall it; only the size (which the native driver cannot animate) changes from JavaScript
      Animated.parallel(
        keys.map(key =>
          Animated.timing(values[key], {
            toValue: target[key],
            duration: MOTION.move,
            easing: ease,
            useNativeDriver: key === 'x' || key === 'y',
          }),
        ),
      ).start(({finished}) => {
        if (finished) {
          moving.current = false;
          move.settled = target;
        }
      });
      moving.current = true;
    },
    [reduced, values, remember],
  );

  useEffect(() => place(true), [selected, place]);

  const onItemLayout = useCallback(
    (index: number) => (event: LayoutChangeEvent) => {
      const frame = event.nativeEvent.layout;
      frames.current[index] = frame;
      if (track) {
        setLaid(previous => {
          const known = previous[index];
          const same =
            known && known.x === frame.x && known.y === frame.y && known.width === frame.width && known.height === frame.height;
          return same ? previous : {...previous, [index]: frame};
        });
      }
      if (index === current.current) {
        // the option picked often changes size as it is drawn selected: a move under way
        // heads for its new frame instead of jumping there
        place(moving.current);
      }
    },
    [place, track],
  );

  const pill = (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: placed && selected >= 0 ? 1 : 0,
        transform: [{translateX: values.x}, {translateY: values.y}],
      }}>
      <Animated.View
        testID="sliding-selection"
        style={[
          {width: values.width, height: values.height, borderRadius: radius, backgroundColor: accent},
          style,
        ]}
      />
    </Animated.View>
  );
  const indicator = track ? (
    <>
      {Object.entries(laid).map(([index, frame]) => (
        <Animated.View
          key={`track-${index}`}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
            backgroundColor: track,
          }}
        />
      ))}
      {pill}
    </>
  ) : (
    pill
  );
  // an option paints its own background until the row draws it (the indicator, the track)
  const selectedBackground = (active: boolean, index?: number): ViewStyle | null => {
    if (active) {
      return {backgroundColor: placed ? 'transparent' : accent};
    }
    if (!track || index === undefined) {
      return null;
    }
    return {backgroundColor: laid[index] ? 'transparent' : track};
  };
  return {indicator, onItemLayout, selectedBackground};
}

/** Where a sliding selection sits within its row. */
type Place = {x: number; y: number; width: number; height: number};

/** Where each remembered row's accent last came to rest (useSlidingSelection's `remember`). */
const lastPlaces = new Map<string, {settled: Place}>();

/**
 * Something that appears in place (a drop-down's panel): it fades in while settling down from
 * just above, or simply appears under reduced motion.
 */
export function Reveal({children, style}: {children: React.ReactNode; style?: StyleProp<ViewStyle>}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {toValue: 1, duration: MOTION.enter, easing: ease, useNativeDriver: true}).start();
  }, [progress, reduced]);
  const translateY = progress.interpolate({inputRange: [0, 1], outputRange: [-6, 0]});
  return <Animated.View style={[style, {opacity: progress, transform: [{translateY}]}]}>{children}</Animated.View>;
}
