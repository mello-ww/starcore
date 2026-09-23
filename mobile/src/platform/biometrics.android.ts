import ReactNativeBiometrics, {BiometryTypes} from 'react-native-biometrics';
import type {BiometricAuthenticator, BiometryType} from './types';

const rnBiometrics = new ReactNativeBiometrics({allowDeviceCredentials: false});

function mapBiometryType(type?: string): BiometryType {
  switch (type) {
    case BiometryTypes.TouchID:
    case BiometryTypes.Biometrics:
      return 'fingerprint';
    case BiometryTypes.FaceID:
      return 'face';
    default:
      return 'none';
  }
}

/**
 * Android implementation of `BiometricAuthenticator`, via
 * `react-native-biometrics` (which itself wraps `BiometricPrompt` /
 * fingerprint APIs depending on API level). Used only to check availability
 * and to show the OS prompt for its own sake (see the interface docstring
 * in `types.ts`) - releasing the actual session token is `SecureStore`'s
 * job, not this one's.
 */
class AndroidBiometricAuthenticator implements BiometricAuthenticator {
  async isAvailable(): Promise<{available: boolean; biometryType: BiometryType}> {
    try {
      const {available, biometryType} = await rnBiometrics.isSensorAvailable();
      return {available, biometryType: mapBiometryType(biometryType)};
    } catch {
      return {available: false, biometryType: 'none'};
    }
  }

  async authenticate(promptMessage: string): Promise<boolean> {
    try {
      const {success} = await rnBiometrics.simplePrompt({promptMessage});
      return success;
    } catch {
      return false;
    }
  }
}

export const biometrics: BiometricAuthenticator = new AndroidBiometricAuthenticator();
