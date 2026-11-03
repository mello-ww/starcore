import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react';

/**
 * Developer Mode: whether advanced settings, diagnostics and developer tools are shown.
 *
 * A visibility preference only, never a permission - every route keeps its own server-side
 * authentication and authorization, and nothing secret is ever sent because this is on.
 * Off by default, remembered on this device per server (one account per server here).
 *
 * The shared mechanism (the same one Mission Control uses): a setting, or a declarative
 * screen's section or item, that a Satellite describes with `developer: true` is shown only
 * while this is on - see `visibleToDeveloper` and docs/satellites.md, "Developer Mode".
 */
export const DEVELOPER_MODE_KEY = 'starcore.developerMode';

interface DeveloperModeValue {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const DeveloperModeContext = createContext<DeveloperModeValue>({enabled: false, setEnabled: () => {}});

export function storageKey(serverId: string | null | undefined): string {
  return `${DEVELOPER_MODE_KEY}.${serverId || '-'}`;
}

export function DeveloperModeProvider({serverId, children}: {serverId: string | null | undefined; children: ReactNode}) {
  const [enabled, setState] = useState(false);

  useEffect(() => {
    let active = true;
    setState(false); // another server's choice never carries over
    AsyncStorage.getItem(storageKey(serverId))
      .then(stored => {
        if (active) {
          setState(stored === 'on');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [serverId]);

  const setEnabled = useCallback(
    (value: boolean) => {
      setState(value);
      AsyncStorage.setItem(storageKey(serverId), value ? 'on' : 'off').catch(() => {});
    },
    [serverId],
  );

  const value = useMemo(() => ({enabled, setEnabled}), [enabled, setEnabled]);
  return <DeveloperModeContext.Provider value={value}>{children}</DeveloperModeContext.Provider>;
}

export function useDeveloperMode(): DeveloperModeValue {
  return useContext(DeveloperModeContext);
}

/** Drops whatever a Satellite marked `developer: true` unless Developer Mode is on. */
export function visibleToDeveloper<T>(entries: T[], enabled: boolean): T[] {
  return enabled ? entries : entries.filter(entry => !(entry as {developer?: unknown})?.developer);
}
