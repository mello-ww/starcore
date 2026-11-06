import {useState} from 'react';
import {usePinchColumnsGesture} from '../components/pinchColumns';
import {DEFAULT_COLUMNS, MAX_COLUMNS, MIN_COLUMNS} from './PhotoGrid';

/**
 * Pinch-to-zoom grid density for Photo's own library grid - "mobile pinch-zoom for grid
 * density" in the task brief. The gesture itself is the shared one (src/components/
 * pinchColumns.ts), which the UI contract's media-grid uses too: pinching out shows fewer,
 * bigger tiles per row, pinching in more and smaller ones, applied once the fingers lift.
 */
export function usePinchColumns(initial: number = DEFAULT_COLUMNS) {
  const [columns, setColumns] = useState(initial);
  const gesture = usePinchColumnsGesture(columns, MIN_COLUMNS, MAX_COLUMNS, setColumns);
  return {columns, gesture};
}
