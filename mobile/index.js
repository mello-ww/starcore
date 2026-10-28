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
import BackgroundFetch from 'react-native-background-fetch';
import App from './src/App';
import {backgroundFetchHeadlessTask} from './src/photo/backgroundSyncTask';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);

// Registered here, not only inside App.tsx's own BackgroundFetch.configure
// call (see backgroundSyncTask.ts), because Android can start the JS engine
// solely to run a periodic tick with no app UI ever mounted (the app was
// swiped away or killed by the system, or hasn't been opened since a
// reboot) - this is what makes that headless run possible at all. It does
// NOT cover an explicit "Force stop" from Android's app settings: Android
// then runs none of the app's background work until the user opens it
// again. See "Real automatic phone sync" in docs/satellites/photo.md.
BackgroundFetch.registerHeadlessTask(backgroundFetchHeadlessTask);
