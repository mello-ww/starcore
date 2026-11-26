import {claimsSwipe, swipeTarget} from '../src/navigation/tabSwipe';

// swiping sideways on a screen moves between the app's main tabs
const tabs = {index: 1, routes: [{name: 'Overview'}, {name: 'Satellites'}, {name: 'Settings'}]};

describe('swiping between the main tabs', () => {
  it('opens the next tab on a swipe to the left and the previous one to the right', () => {
    expect(swipeTarget(tabs, -90, 5, 0)).toBe('Settings');
    expect(swipeTarget(tabs, 90, 5, 0)).toBe('Overview');
  });

  it('takes a quick flick shorter than a full swipe', () => {
    expect(swipeTarget(tabs, -40, 0, -0.9)).toBe('Settings');
    expect(swipeTarget(tabs, -40, 0, -0.1)).toBeNull();
  });

  it('does not wrap past either end', () => {
    expect(swipeTarget({...tabs, index: 2}, -90, 0, 0)).toBeNull();
    expect(swipeTarget({...tabs, index: 0}, 90, 0, 0)).toBeNull();
  });

  it('ignores a move that is mostly vertical, or no state', () => {
    expect(swipeTarget(tabs, -90, 60, 0)).toBeNull();
    expect(swipeTarget(null, -90, 0, 0)).toBeNull();
  });

  it('only claims a one-finger move that is clearly sideways', () => {
    expect(claimsSwipe({dx: 30, dy: 4, numberActiveTouches: 1})).toBe(true);
    expect(claimsSwipe({dx: 12, dy: 0, numberActiveTouches: 1})).toBe(false);
    expect(claimsSwipe({dx: 30, dy: 20, numberActiveTouches: 1})).toBe(false);
    expect(claimsSwipe({dx: 60, dy: 0, numberActiveTouches: 2})).toBe(false);
  });
});
