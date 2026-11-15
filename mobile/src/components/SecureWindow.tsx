import React from 'react';
import {requireNativeComponent, StyleSheet, UIManager, View, type ViewProps} from 'react-native';

/**
 * Makes the window it is drawn in uncapturable: no screenshot, no screen recording. Put it
 * inside a `Modal` that shows private content.
 *
 * `privacy.setSecure` covers the app's own window, but a Modal is a window of its own and does
 * not take that from it: without this marker a full-screen viewer, a PIN prompt or a revealed
 * secret drawn in a Modal could be captured while the screen behind it could not
 * (android/.../privacy/SecureWindowManager.kt). It draws nothing and takes no space. With
 * `secure` false, or where the native view isn't there (tests), it does nothing.
 */
const NAME = 'StarCoreSecureWindow';
const NativeSecureWindow = UIManager.getViewManagerConfig?.(NAME) ? requireNativeComponent<ViewProps>(NAME) : null;

export function SecureWindow({secure = true}: {secure?: boolean}) {
  if (!secure) {
    return null;
  }
  const Marker = NativeSecureWindow ?? View;
  return <Marker style={styles.marker} pointerEvents="none" collapsable={false} testID="secure-window" />;
}

const styles = StyleSheet.create({
  marker: {position: 'absolute', width: 0, height: 0},
});
