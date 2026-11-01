import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';

/**
 * A react-native Modal is its own Android window, so insets measured by the app's root
 * SafeAreaProvider say nothing about it: a modal that draws under the status bar (or the
 * gesture bar) would read zero insets from outside. Wrapping a modal's content in this gives
 * `useSafeAreaInsets()` the modal window's own insets, whether or not edge-to-edge is on.
 */
export function ModalSafeArea({children}: {children: React.ReactNode}) {
  return <SafeAreaProvider style={{flex: 1}}>{children}</SafeAreaProvider>;
}
