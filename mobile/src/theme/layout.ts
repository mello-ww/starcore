/** Android's minimum comfortable touch target, in dp. */
export const TOUCH_TARGET = 48;

/** Style for a control whose glyph is smaller than a finger: centres it in a 48 dp box. */
export const touchTarget = {
  minWidth: TOUCH_TARGET,
  minHeight: TOUCH_TARGET,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
