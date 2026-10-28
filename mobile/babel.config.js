module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // react-native-reanimated's plugin must be listed last (its own docs are
  // explicit about this - it rewrites worklets after every other plugin has
  // run) - added for PhotoViewerScreen's pinch-to-zoom and PhotoLibraryTab's
  // pinch-to-zoom-grid-density (see usePinchColumns.ts), the only two things
  // in this app that use react-native-reanimated.
  plugins: ['react-native-reanimated/plugin'],
};
