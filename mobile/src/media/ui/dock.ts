import AsyncStorage from '@react-native-async-storage/async-storage';
import {useSyncExternalStore} from 'react';

/** Whether the mini-player is put away: it then waits in the header as the playing cover, a
 * spinning disc. Shared by the bar and the disc, and remembered across launches. */
const KEY = 'starcore_music_player_collapsed';
let collapsed = false;
const listeners = new Set<() => void>();

AsyncStorage.getItem(KEY)
  .then(value => value === '1' && setPlayerCollapsed(true))
  .catch(() => {});

export function setPlayerCollapsed(value: boolean) {
  if (value === collapsed) {
    return;
  }
  collapsed = value;
  listeners.forEach(listener => listener());
  AsyncStorage.setItem(KEY, value ? '1' : '0').catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlayerCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => collapsed);
}

/** Where the visible disc and the bar's cover are on screen, measured by each as it lays out,
 * so the cover's flight between them needs no fixed offsets. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const anchors: {disc: Rect | null; cover: Rect | null} = {disc: null, cover: null};
