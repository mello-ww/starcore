import {NativeModules} from 'react-native';

interface NativePrivacy {
  setSecure(secure: boolean): void;
  evictImages(urls: string[]): void;
}

const native: NativePrivacy | undefined = NativeModules.StarCorePrivacy;

/**
 * The app's own privacy module (android/.../privacy/PrivacyModule.kt).
 * Both calls are best effort and do nothing where the module isn't
 * available (tests, or an older build).
 */
export const privacy = {
  /** FLAG_SECURE while private content is showing: no screenshots, screen
   * recording or recent-apps preview. Each `true` needs a matching `false`. */
  setSecure(secure: boolean): void {
    native?.setSecure(secure);
  },

  /** Drops these image URLs from the platform's image caches. */
  evictImages(urls: string[]): void {
    if (urls.length) {
      native?.evictImages(urls);
    }
  },
};
