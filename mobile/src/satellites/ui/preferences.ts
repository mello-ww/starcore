import AsyncStorage from '@react-native-async-storage/async-storage';

/** What a shared interface remembers for the person using it (a media-grid's size), per
 * server and per Satellite: two servers, or two Satellites, never share a choice. */
export interface UiPreferences {
  /** What is known already, without waiting: a value, null for nothing stored, undefined when
   * it hasn't been read yet. */
  peek: (key: string) => string | null | undefined;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string | null) => void;
}

// read once per app run, so a page opened again lays out at the remembered size at once
const known = new Map<string, string | null>();

export function uiPreferences(serverId: string, satellite: string): UiPreferences {
  const full = (key: string) => `starcore_ui_pref:${serverId}:${satellite}:${key}`;
  return {
    peek: key => known.get(full(key)),
    get: async key => {
      const name = full(key);
      if (known.has(name)) {
        return known.get(name) ?? null;
      }
      const value = await AsyncStorage.getItem(name).catch(() => null);
      known.set(name, value);
      return value;
    },
    set: (key, value) => {
      const name = full(key);
      known.set(name, value);
      (value === null ? AsyncStorage.removeItem(name) : AsyncStorage.setItem(name, value)).catch(() => undefined);
    },
  };
}

/** For tests: forget what this run has read. */
export function forgetUiPreferences() {
  known.clear();
}
