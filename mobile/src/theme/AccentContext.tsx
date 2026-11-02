import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {AccentName, DEFAULT_ACCENT, accentColor, isAccentName, normalizeHex, onAccentFor} from './tokens';

export const ACCENT_STORAGE_KEY = 'starcore.accent';

/** A preset's name, or 'custom' for a colour picked by HEX. */
export type AccentChoice = AccentName | 'custom';

interface AccentValue {
  accent: AccentChoice;
  /** The accent as #rrggbb. */
  color: string;
  /** Text and icons drawn on an accent fill, picked for contrast. */
  onColor: string;
  /** A preset's name or any HEX colour (#rgb / #rrggbb); anything else is ignored. */
  setAccent: (value: string) => void;
}

const AccentContext = createContext<AccentValue>({
  accent: DEFAULT_ACCENT,
  color: accentColor(DEFAULT_ACCENT),
  onColor: onAccentFor(accentColor(DEFAULT_ACCENT)),
  setAccent: () => {},
});

/** Stored as the preset's name or the custom colour's #rrggbb, kept on this device only. */
function parse(stored: unknown): {accent: AccentChoice; color: string} | null {
  if (isAccentName(stored)) {
    return {accent: stored, color: accentColor(stored)};
  }
  const hex = normalizeHex(stored);
  return hex ? {accent: 'custom', color: hex} : null;
}

export function AccentProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState({accent: DEFAULT_ACCENT as AccentChoice, color: accentColor(DEFAULT_ACCENT)});

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(ACCENT_STORAGE_KEY)
      .then(stored => {
        const parsed = parse(stored);
        if (active && parsed) {
          setState(parsed);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const setAccent = useCallback((value: string) => {
    const parsed = parse(value);
    if (!parsed) {
      return;
    }
    setState(parsed);
    AsyncStorage.setItem(ACCENT_STORAGE_KEY, parsed.accent === 'custom' ? parsed.color : parsed.accent).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({accent: state.accent, color: state.color, onColor: onAccentFor(state.color), setAccent}),
    [state, setAccent],
  );
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

export function useAccent(): AccentValue {
  return useContext(AccentContext);
}

/** The live accent as ready-made style fragments, for screens whose StyleSheet is built once at
 * startup: apply `text`, `fill` or `border` next to the static style so a new accent shows at once,
 * and `onFill` to text sitting on an accent fill. */
export function useAccentStyles() {
  const {color, onColor} = useAccent();
  return useMemo(
    () => ({
      color,
      onColor,
      text: {color},
      fill: {backgroundColor: color, borderColor: color},
      border: {borderColor: color},
      onFill: {color: onColor},
    }),
    [color, onColor],
  );
}
