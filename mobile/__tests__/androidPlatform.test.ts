/**
 * The Android adapters themselves, against mocked native modules: how
 * react-native-biometrics reports a prompt dismissed by tapping outside it
 * (a rejected promise - BiometricPrompt's ERROR_CANCELED - rather than a
 * resolved `{success: false}`), and that the Keystore wrapper never turns
 * an unreadable store into an apparently empty one for security flags.
 */
const mockSimplePrompt = jest.fn();
const mockIsSensorAvailable = jest.fn();

jest.mock('react-native-biometrics', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    isSensorAvailable: (...args: unknown[]) => mockIsSensorAvailable(...args),
    simplePrompt: (...args: unknown[]) => mockSimplePrompt(...args),
  })),
  BiometryTypes: {TouchID: 'TouchID', FaceID: 'FaceID', Biometrics: 'Biometrics'},
}));

import * as Keychain from 'react-native-keychain';
import {biometrics} from '../src/platform/biometrics';
import {secureStorage} from '../src/platform/secureStorage';

describe('Android biometric prompt', () => {
  beforeEach(() => {
    mockSimplePrompt.mockReset();
    mockIsSensorAvailable.mockReset();
  });

  it('authenticates on a successful match', async () => {
    mockSimplePrompt.mockResolvedValue({success: true});

    expect(await biometrics.authenticate('Unlock')).toBe(true);
  });

  it('is false when the user taps Cancel (resolved, "User cancellation")', async () => {
    mockSimplePrompt.mockResolvedValue({success: false, error: 'User cancellation'});

    expect(await biometrics.authenticate('Unlock')).toBe(false);
  });

  it('is false, not an exception, when the prompt is dismissed by tapping outside it', async () => {
    mockSimplePrompt.mockRejectedValue(new Error('Authentication canceled'));

    await expect(biometrics.authenticate('Unlock')).resolves.toBe(false);
  });

  it.each(['Too many attempts. Try again later.', 'Hardware unavailable', 'Timed out'])(
    'is false when the prompt errors out: %s',
    async message => {
      mockSimplePrompt.mockRejectedValue(new Error(message));

      await expect(biometrics.authenticate('Unlock')).resolves.toBe(false);
    },
  );

  it('is false for any result that is not an explicit success', async () => {
    mockSimplePrompt.mockResolvedValue({});
    expect(await biometrics.authenticate('Unlock')).toBe(false);

    mockSimplePrompt.mockResolvedValue(undefined);
    expect(await biometrics.authenticate('Unlock')).toBe(false);
  });

  it('reports a usable sensor', async () => {
    mockIsSensorAvailable.mockResolvedValue({available: true, biometryType: 'Biometrics'});

    expect(await biometrics.isAvailable()).toEqual({available: true, biometryType: 'fingerprint'});
  });

  it.each([
    ['BIOMETRIC_ERROR_NO_HARDWARE', 'no-hardware'],
    ['BIOMETRIC_ERROR_NONE_ENROLLED', 'not-enrolled'],
    ['BIOMETRIC_ERROR_HW_UNAVAILABLE', 'unavailable'],
    [undefined, 'unavailable'],
  ])('maps %s to %s', async (error, reason) => {
    mockIsSensorAvailable.mockResolvedValue({available: false, error});

    expect(await biometrics.isAvailable()).toEqual({available: false, biometryType: 'none', reason});
  });

  it('reports unavailable when the availability check itself throws', async () => {
    mockIsSensorAvailable.mockRejectedValue(new Error('native error'));

    expect(await biometrics.isAvailable()).toEqual({available: false, biometryType: 'none', reason: 'unavailable'});
  });
});

describe('Android secure storage', () => {
  const keychain = Keychain as unknown as {
    setGenericPassword: jest.Mock;
    getGenericPassword: jest.Mock;
    resetGenericPassword: jest.Mock;
  };

  beforeEach(() => {
    keychain.setGenericPassword.mockReset().mockResolvedValue(true);
    keychain.getGenericPassword.mockReset().mockResolvedValue(false);
    keychain.resetGenericPassword.mockReset().mockResolvedValue(true);
  });

  it('reads a stored value', async () => {
    keychain.getGenericPassword.mockResolvedValue({username: 'k', password: 'true'});

    expect(await secureStorage.getItem('k')).toBe('true');
    expect(await secureStorage.getItemStrict('k')).toBe('true');
  });

  it('treats an absent entry as null in both reads', async () => {
    expect(await secureStorage.getItem('k')).toBeNull();
    expect(await secureStorage.getItemStrict('k')).toBeNull();
  });

  it('lets a Keystore read error reject from getItemStrict, while getItem stays null', async () => {
    keychain.getGenericPassword.mockRejectedValue(new Error('E_KEYSTORE_ACCESS_ERROR'));

    await expect(secureStorage.getItemStrict('k')).rejects.toThrow();
    expect(await secureStorage.getItem('k')).toBeNull();
  });

  it('never writes an entry with biometric access control', async () => {
    await secureStorage.setItem('k', 'v');

    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    expect(keychain.setGenericPassword.mock.calls[0][2]).not.toHaveProperty('accessControl');
  });

  it('retries a failed write once after clearing the alias', async () => {
    keychain.setGenericPassword.mockRejectedValueOnce(new Error('E_CRYPTO_FAILED'));

    await secureStorage.setItem('k', 'v');

    expect(keychain.resetGenericPassword).toHaveBeenCalledWith({service: 'k'});
    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(2);
  });
});
