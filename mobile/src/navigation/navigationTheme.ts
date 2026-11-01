import {DarkTheme, Theme} from '@react-navigation/native';
import {useMemo} from 'react';
import {colors, useAccent} from '../theme';

/** React Navigation's colours on the StarCore palette, with `primary` following the live accent. */
export function useNavigationTheme(): Theme {
  const {color} = useAccent();
  return useMemo(
    () => ({
      ...DarkTheme,
      colors: {
        ...DarkTheme.colors,
        background: colors.void,
        card: colors.surface,
        border: colors.line,
        text: colors.text,
        primary: color,
      },
    }),
    [color],
  );
}
