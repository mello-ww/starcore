import {useCallback, useState} from 'react';
import {Gesture} from 'react-native-gesture-handler';
import {runOnJS} from 'react-native-reanimated';
import {DEFAULT_COLUMNS, MAX_COLUMNS, MIN_COLUMNS} from './PhotoGrid';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pinch-to-zoom grid density - "mobile pinch-zoom for grid density" in the
 * task brief - built on the same two approved dependencies
 * (react-native-gesture-handler + react-native-reanimated) PhotoViewerScreen's
 * own pinch-to-zoom uses, rather than a second gesture library.
 *
 * Pinching out (fingers spreading apart, scale > 1) shows fewer, bigger
 * tiles per row; pinching in shows more, smaller ones - the same direction
 * a camera app's own zoom gesture uses. The column count is only recomputed
 * once, at gesture end, rather than continuously while fingers are still
 * moving - a SectionList re-layouting every frame during the gesture itself
 * would be far more jank than useful.
 */
export function usePinchColumns(initial: number = DEFAULT_COLUMNS) {
  const [columns, setColumns] = useState(initial);

  const applyPinch = useCallback((scale: number, startColumns: number) => {
    const next = clamp(Math.round(startColumns / scale), MIN_COLUMNS, MAX_COLUMNS);
    setColumns(next);
  }, []);

  const gesture = Gesture.Pinch().onEnd(event => {
    runOnJS(applyPinch)(event.scale, columns);
  });

  return {columns, gesture};
}
