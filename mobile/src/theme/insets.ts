import {useContext} from 'react';
import {SafeAreaInsetsContext} from 'react-native-safe-area-context';

/** The top safe-area inset, or 0 when rendered outside a SafeAreaProvider (as in tests). */
export function useTopInset(): number {
  return useContext(SafeAreaInsetsContext)?.top ?? 0;
}
