import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {AccentName, DEFAULT_ACCENT, accentColor, isAccentName} from './tokens';

export const ACCENT_STORAGE_KEY = 'starcore.accent';

interface AccentValue {
  accent: AccentName;
  color: string;
  setAccent: (name: AccentName) => void;
}

const AccentContext = createContext<AccentValue>({
  accent: DEFAULT_ACCENT,
  color: accentColor(DEFAULT_ACCENT),
  setAccent: () => {},
});

/** The accent colour preference, kept on this device only. */
export function AccentProvider({children}: {children: ReactNode}) {
  const [accent, setAccentState] = useState<AccentName>(DEFAULT_ACCENT);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(ACCENT_STORAGE_KEY)
      .then(stored => {
        if (active && isAccentName(stored)) {
          setAccentState(stored);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const setAccent = useCallback((name: AccentName) => {
    setAccentState(name);
    AsyncStorage.setItem(ACCENT_STORAGE_KEY, name).catch(() => {});
  }, []);

  const value = useMemo(() => ({accent, color: accentColor(accent), setAccent}), [accent, setAccent]);
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

export function useAccent(): AccentValue {
  return useContext(AccentContext);
}

/** The live accent as ready-made style fragments, for screens whose StyleSheet is built once at
 * startup: apply `text`, `fill` or `border` next to the static style so a new accent shows at once. */
export function useAccentStyles() {
  const {color} = useAccent();
  return useMemo(
    () => ({
      color,
      text: {color},
      fill: {backgroundColor: color, borderColor: color},
      border: {borderColor: color},
    }),
    [color],
  );
}
