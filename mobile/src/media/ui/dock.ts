import AsyncStorage from '@react-native-async-storage/async-storage';
import {useSyncExternalStore} from 'react';

/** Whether the mini-player is put away: it then waits in the header as the playing cover, a
 * spinning disc. Shared by the bar and the disc, and remembered across launches. */
const KEY = 'starcore_player_collapsed';
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

/** How many full-screen media viewers are open: while one is, the bar steps out of the way
 * and comes back after. Not remembered; counted, as a viewer may open over another one. */
let viewers = 0;

/** Called by a viewer as it opens; the function it returns is called as it closes. */
export function holdPlayerAside(): () => void {
  viewers += 1;
  listeners.forEach(listener => listener());
  let released = false;
  return () => {
    if (!released) {
      released = true;
      viewers -= 1;
      listeners.forEach(listener => listener());
    }
  };
}

export function usePlayerAside(): boolean {
  return useSyncExternalStore(subscribe, () => viewers > 0);
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
