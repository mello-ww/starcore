import {Platform} from 'react-native';
import {colors} from './colors';

/**
 * Mission Control's `--sans`/`--mono` stacks are web font-family lists;
 * neither means anything to a native Text element, so this picks the
 * closest system-provided equivalent per platform instead. The touch UI
 * otherwise mirrors the desktop app's type scale (see style.css), just
 * without a web font stack to match exactly.
 */
export const fonts = Platform.select({
  android: {sans: 'sans-serif', mono: 'monospace'},
  ios: {sans: 'System', mono: 'Menlo'},
  default: {sans: 'System', mono: 'monospace'},
})!;

// Android only renders the default family in regular or bold, so headings use bold
export const typography = {
  title: {fontFamily: fonts.sans, fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.text},
  heading: {fontFamily: fonts.sans, fontSize: 17, fontWeight: '700' as const, color: colors.text},
  body: {fontFamily: fonts.sans, fontSize: 15, color: colors.text},
  caption: {fontFamily: fonts.sans, fontSize: 13, color: colors.textDim},
  label: {fontFamily: fonts.sans, fontSize: 13, color: colors.textFaint},
  mono: {fontFamily: fonts.mono, fontSize: 14, color: colors.textDim},
};
