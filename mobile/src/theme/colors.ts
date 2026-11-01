import {palette} from './tokens';

/**
 * The palette every older screen styles itself with, mapped onto the
 * StarCore design tokens (tokens.ts) so the whole app shares one look.
 * The accent entries are the default red: these values are read once at
 * startup, so only screens using useAccent() follow the chosen accent.
 */
const ACCENT = '#ee444b';

export const colors = {
  void: palette.bg,
  deep: palette.bg,
  surface: palette.card,
  raised: palette.control,
  // separators mostly sit on cards, so they need to be lighter than the card itself
  line: '#2e2f36',
  lineBright: '#3a3c44',

  klein: ACCENT,
  sapphire: ACCENT,
  royal: ACCENT,
  azure: ACCENT,
  ice: palette.text,

  text: palette.text,
  textDim: palette.text2,
  textFaint: palette.text3,

  ok: palette.textIcon,
  alert: palette.danger,

  /** Text drawn on an accent fill. */
  onAccent: palette.onAccent,
  /** A selected chip or segment: a light pill with dark text. */
  selected: palette.textIcon,
  onSelected: palette.onAccent,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;
