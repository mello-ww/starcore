import {useEffect, useState} from 'react';
import {AppState} from 'react-native';

/** Whether the app is in the foreground - live screens stop polling when it isn't. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => {
    const state = AppState.currentState as unknown;
    return typeof state !== 'string' || state === 'active';
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => subscription?.remove?.();
  }, []);
  return active;
}
