import ReactNativeBiometrics, {BiometryTypes} from 'react-native-biometrics';
import type {
  BiometricAuthenticator,
  BiometricAvailability,
  BiometricSigner,
  BiometricUnavailableReason,
  BiometryType,
  SignResult,
} from './types';

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

/**
 * Android implementation of `BiometricSigner`, via react-native-biometrics'
 * Keystore key (RSA 2048, SHA256withRSA, user authentication required, so
 * every signature needs a BIOMETRIC_STRONG match and new enrollments
 * invalidate the key). The global app lock above never uses this key.
 */
class AndroidBiometricSigner implements BiometricSigner {
  isAvailable(): Promise<BiometricAvailability> {
    return biometrics.isAvailable();
  }

  async keyExists(): Promise<boolean> {
    try {
      const {keysExist} = await rnBiometrics.biometricKeysExist();
      return keysExist === true;
    } catch {
      return false;
    }
  }

  async createKey(): Promise<string | null> {
    try {
      const {publicKey} = await rnBiometrics.createKeys();
      return publicKey || null;
    } catch {
      return null;
    }
  }

  async sign(promptMessage: string, payload: string): Promise<SignResult> {
    try {
      const {success, signature} = await rnBiometrics.createSignature({promptMessage, payload});
      return success && signature ? {status: 'signed', signature} : {status: 'cancelled'};
    } catch {
      // the key couldn't be initialised for signing: deleted, or invalidated
      // by a change to the enrolled biometrics
      return {status: 'key-invalid'};
    }
  }

  async deleteKey(): Promise<void> {
    try {
      await rnBiometrics.deleteKeys();
    } catch {
      // nothing to delete
    }
  }
}

export const biometricSigner: BiometricSigner = new AndroidBiometricSigner();
