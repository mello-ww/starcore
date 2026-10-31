import ReactNativeBiometrics, {BiometryTypes} from 'react-native-biometrics';
import type {BiometricAuthenticator, BiometricAvailability, BiometricUnavailableReason, BiometryType} from './types';

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

function mapUnavailableReason(error?: string): BiometricUnavailableReason {
  switch (error) {
    case 'BIOMETRIC_ERROR_NO_HARDWARE':
      return 'no-hardware';
    case 'BIOMETRIC_ERROR_NONE_ENROLLED':
      return 'not-enrolled';
    default:
      return 'unavailable';
  }
}

/**
 * Android implementation of `BiometricAuthenticator`, via
 * `react-native-biometrics` (BiometricManager / BiometricPrompt with
 * BIOMETRIC_STRONG and no device-credential fallback).
 */
class AndroidBiometricAuthenticator implements BiometricAuthenticator {
  async isAvailable(): Promise<BiometricAvailability> {
    try {
      const {available, biometryType, error} = await rnBiometrics.isSensorAvailable();
      if (available) {
        return {available: true, biometryType: mapBiometryType(biometryType)};
      }
      return {available: false, biometryType: 'none', reason: mapUnavailableReason(error)};
    } catch {
      return {available: false, biometryType: 'none', reason: 'unavailable'};
    }
  }

  async authenticate(promptMessage: string): Promise<boolean> {
    try {
      const {success} = await rnBiometrics.simplePrompt({promptMessage});
      return success === true;
    } catch {
      // lockout, hardware error, no foreground activity, ...
      return false;
    }
  }
}

export const biometrics: BiometricAuthenticator = new AndroidBiometricAuthenticator();
