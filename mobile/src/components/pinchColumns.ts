import {useCallback, useMemo} from 'react';
import {Gesture} from 'react-native-gesture-handler';
import {runOnJS} from 'react-native-reanimated';

/** The column count a pinch of `scale` leads to from `start`: spreading the fingers (scale > 1)
 * shows fewer, bigger tiles; pinching in, more and smaller - the way a camera app zooms. */
export function pinchedColumns(start: number, scale: number, min: number, max: number): number {
  const next = Math.round(start / (scale > 0 ? scale : 1));
  return Math.min(max, Math.max(min, next));
}

/**
 * A pinch over a grid that changes its column count once, when the fingers lift - re-laying out
 * a list on every frame of the gesture would be far more jank than useful. Two fingers only, so
 * it never takes a one-finger scroll or a tile's press. Shared by Photo's own grid and the UI
 * contract's media-grid.
 */
export function usePinchColumnsGesture(columns: number, min: number, max: number, onChange: (next: number) => void) {
  const apply = useCallback(
    (scale: number) => {
      const next = pinchedColumns(columns, scale, min, max);
      if (next !== columns) {
        onChange(next);
      }
    },
    [columns, min, max, onChange],
  );
  return useMemo(
    () =>
      Gesture.Pinch().onEnd(event => {
        runOnJS(apply)(event.scale);
      }),
    [apply],
  );
}
