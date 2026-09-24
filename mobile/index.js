/**
 * @format
 * Entry point registered with the native host (MainActivity.kt on Android,
 * a future AppDelegate on iOS) - both just call AppRegistry.runApplication
 * for this same component name, so this file never changes per platform.
 */
import {AppRegistry} from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import App from './src/App';
import {backgroundFetchHeadlessTask} from './src/photo/backgroundSyncTask';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);

// Registered here, not only inside App.tsx's own BackgroundFetch.configure
// call (see backgroundSyncTask.ts), because Android can start the JS engine
// solely to run a periodic tick with no app UI ever mounted (the app was
// force-stopped, or hasn't been opened since a reboot) - this is what makes
// that headless run possible at all. See "Real automatic phone sync" in
// docs/satellites/photo.md.
BackgroundFetch.registerHeadlessTask(backgroundFetchHeadlessTask);
