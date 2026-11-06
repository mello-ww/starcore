/**
 * Global Jest setup for the mobile app's test suite.
 *
 * Native modules (secure storage, biometrics) have no JS implementation to
 * run under Node, so they're mocked here at the module level - the same
 * modules `src/platform/*.android.ts` import. Tests for `src/auth/*` and
 * `src/api/*` never talk to these directly anyway (see the platform
 * abstraction in src/platform/), so this mainly keeps screen-level tests
 * from crashing on an unmocked native import.
 */

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly'},
  ACCESS_CONTROL: {BIOMETRY_CURRENT_SET: 'BiometryCurrentSet'},
}));

jest.mock('react-native-biometrics', () => {
  return jest.fn().mockImplementation(() => ({
    isSensorAvailable: jest.fn(() =>
      Promise.resolve({available: false, biometryType: undefined}),
    ),
    simplePrompt: jest.fn(() => Promise.resolve({success: false})),
  }));
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// This project's react-native-screens (3.31.1) predates that package's own
// `/mock` entry point, so it's stubbed by hand instead - a real
// NativeStackNavigator (see navigation/OnboardingNavigator.tsx,
// navigation/MainTabs.tsx) only ever reaches react-native-screens for its
// `Screen`/`ScreenStack` components (see
// @react-navigation/native-stack/.../NativeStackView.native.js), so plain
// Views stand in for both under Jest - there is no real native screen host
// to render against here anyway.
jest.mock('react-native-screens', () => {
  const {View} = require('react-native');
  return {
    enableScreens: () => {},
    screensEnabled: () => false,
    Screen: View,
    ScreenStack: View,
    ScreenStackHeaderConfig: View,
    ScreenStackHeaderSubview: View,
    NativeScreen: View,
    NativeScreenContainer: View,
  };
});

// react-native-video's native player has nothing to run under Node; Music's
// provider tests only need the props it is rendered with (see
// __tests__/musicProvider.test.tsx).
jest.mock('react-native-video', () => {
  const React = require('react');
  const {View} = require('react-native');
  const Video = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({seek: jest.fn(), pause: jest.fn(), resume: jest.fn()}));
    return React.createElement(View, {testID: 'music-video', ...props});
  });
  return {__esModule: true, default: Video, Video};
});

// Gestures and animations (the shared zoomable image, a media-grid's pinch): both libraries'
// own Jest mocks, so a screen that uses them renders under Node. A test that needs more (the
// startup order tests) still mocks react-native-gesture-handler itself.
require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
