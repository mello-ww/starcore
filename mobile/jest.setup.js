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
