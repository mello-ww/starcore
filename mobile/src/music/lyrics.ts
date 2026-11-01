import type {LyricLine} from './types';

/** Index of the line being sung at `positionMs` (offset already applied by the caller), or -1. */
export function activeLine(lines: LyricLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= positionMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** How many words of a karaoke line have been reached. */
export function activeWords(line: LyricLine | undefined, positionMs: number): number {
  if (!line?.words?.length) {
    return 0;
  }
  return line.words.filter(word => word.time <= positionMs).length;
}

/** Lyrics position for a playback position: a positive offset shows lines later. */
export function lyricsTime(positionSeconds: number, offsetMs: number): number {
  return Math.round(positionSeconds * 1000) - offsetMs;
}
