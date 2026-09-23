const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro bundler config - Android-first, but nothing here is Android-specific.
 * Metro already resolves `.android.ts`/`.ios.ts` platform-suffixed files
 * automatically (see src/platform/README.md), so no extra config is needed
 * to add iOS later.
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
