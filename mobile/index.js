/**
 * @format
 * Entry point registered with the native host (MainActivity.kt on Android,
 * a future AppDelegate on iOS) - both just call AppRegistry.runApplication
 * for this same component name, so this file never changes per platform.
 */
import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
