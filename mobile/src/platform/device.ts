import {Platform} from 'react-native';
import type {DeviceInfo} from './types';

/**
 * Not platform-suffixed like the other two files in this directory - it
 * needs nothing beyond React Native's own cross-platform `Platform` module,
 * so there's no Android-specific behavior here to abstract away yet. If a
 * future need (a real device model/name, not just the OS) requires a
 * native module, this file - and only this file - would gain an
 * `.android.ts`/`.ios.ts` split; nothing that imports `DeviceInfo` would
 * need to change.
 */
class BasicDeviceInfo implements DeviceInfo {
  displayName(): string {
    return `StarCore mobile (${Platform.OS === 'android' ? 'Android' : Platform.OS})`;
  }
}

export const deviceInfo: DeviceInfo = new BasicDeviceInfo();
