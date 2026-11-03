import {Platform} from 'react-native';

/** StarCore design tokens. Mirrored by hand in mission_control/tokens.css. */
export const palette = {
  bg: '#101114',
  card: '#212228',
  control: '#24252b',
  controlStrong: '#34363d',
  field: '#17181c',
  line: '#222329',

  text: '#ffffff',
  textIcon: '#e6e7eb',
  text2: '#a6a8b1',
  text3: '#8b8f9a',

  onAccent: '#141215',
  danger: '#ee444b',
  warn: '#f0b43c',

  /** The second series of a two-series chart (upload, disk writes); the first is the accent.
   * Checked against every accent preset on the card colour for colour-blind separation. */
  chart2: '#7d808a',
} as const;

export const ACCENTS = [
  {name: 'red', label: 'Red', color: '#ee444b'},
  {name: 'orange', label: 'Orange', color: '#f08a3c'},
  {name: 'green', label: 'Green', color: '#45c486'},
  {name: 'blue', label: 'Blue', color: '#5b95f7'},
  {name: 'mono', label: 'Mono', color: '#e6e7eb'},
] as const;

export type AccentName = (typeof ACCENTS)[number]['name'];

export const DEFAULT_ACCENT: AccentName = 'red';

export function accentColor(name: AccentName): string {
  return (ACCENTS.find(accent => accent.name === name) ?? ACCENTS[0]).color;
}

export function isAccentName(value: unknown): value is AccentName {
  return ACCENTS.some(accent => accent.name === value);
}

/** "#abc" / "abc" / "#AABBCC" -> "#aabbcc"; anything else -> null. */
export function normalizeHex(value: unknown): string | null {
  const match = typeof value === 'string' ? /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim()) : null;
  if (!match) {
    return null;
  }
  const digits = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
  return `#${digits.toLowerCase()}`;
}

function luminance(hex: string): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The dark StarCore ink or white - whichever reads better on this accent. */
export function onAccentFor(hex: string): string {
  return contrastRatio(hex, palette.onAccent) >= contrastRatio(hex, '#ffffff') ? palette.onAccent : '#ffffff';
}

export const radii ={card: 16, control: 12} as const;

export const space = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32} as const;

const sans = Platform.select({android: 'sans-serif', default: 'System'});
const display = Platform.select({android: 'sans-serif-medium', default: 'System'});

export const type = {
  eyebrow: {fontFamily: sans, fontSize: 11, fontWeight: '600' as const, letterSpacing: 2.4, color: palette.text3},
  display: {fontFamily: display, fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.6, color: palette.text},
  title: {fontFamily: display, fontSize: 17, fontWeight: '700' as const, color: palette.text},
  body: {fontFamily: sans, fontSize: 15, lineHeight: 21, color: palette.text2},
  // Android only honours bold weights on the default family, so medium text uses Roboto Medium
  label: {fontFamily: display, fontSize: 15, color: palette.text},
  caption: {fontFamily: sans, fontSize: 13, color: palette.text2},
  meta: {fontFamily: sans, fontSize: 12, fontWeight: '600' as const, letterSpacing: 1.6, color: palette.text2},
};
