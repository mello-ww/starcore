/**
 * @format
 * Entry point registered with the native host (MainActivity.kt on Android,
 * a future AppDelegate on iOS) - both just call AppRegistry.runApplication
 * for this same component name, so this file never changes per platform.
 */
// react-native-gesture-handler's own docs require this to be the very first
// import in the entry file, before anything else, so its native event
// handling is installed before any gesture-using screen (PhotoViewerScreen,
// PhotoLibraryTab) can mount.
import 'react-native-gesture-handler';
import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
