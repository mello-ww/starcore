import type {PanResponderGestureState} from 'react-native';

/** What a tab navigator's state looks like to the swipe: its routes in bar order and the current one. */
export interface TabsState {
  index: number;
  routes: {name: string}[];
}

/** A horizontal move this long, or a quick flick past half of it, changes tab. */
const DISTANCE = 64;
const FLICK = 0.5;

/**
 * Whether a move is a horizontal swipe the tabs may take: one finger, mostly sideways, and past
 * a margin larger than the platform's own touch slop, so a horizontal list, a slider or a pinch
 * inside a screen (which claim the touch first, or start scrolling natively before this margin)
 * keep it.
 */
export function claimsSwipe(gesture: Pick<PanResponderGestureState, 'dx' | 'dy' | 'numberActiveTouches'>): boolean {
  return gesture.numberActiveTouches === 1 && Math.abs(gesture.dx) > 24 && Math.abs(gesture.dx) > 2 * Math.abs(gesture.dy);
}

/**
 * The tab a finished swipe lands on, or null: a swipe to the left opens the next tab in the bar,
 * one to the right the previous, and nothing wraps around past either end.
 */
export function swipeTarget(state: TabsState | null | undefined, dx: number, dy: number, vx: number): string | null {
  if (!state || Math.abs(dx) <= 2 * Math.abs(dy)) {
    return null;
  }
  const far = Math.abs(dx) >= DISTANCE || (Math.abs(vx) >= FLICK && Math.abs(dx) >= DISTANCE / 2);
  if (!far) {
    return null;
  }
  const next = state.index + (dx < 0 ? 1 : -1);
  return next >= 0 && next < state.routes.length ? state.routes[next].name : null;
}
