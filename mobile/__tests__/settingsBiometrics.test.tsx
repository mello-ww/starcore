import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Switch, Text} from 'react-native';
import {SettingsScreen} from '../src/screens/SettingsScreen';

// Factory-mocked (not auto-mocked) so requiring this module never pulls in
// its real platform/biometrics or platform/secureStorage imports, which
// Jest (unlike Metro) can't resolve for a bare, unsuffixed import - see
// src/platform/README.md.
jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn()}));

import {useAuth} from '../src/auth/AuthContext';
import {useServers} from '../src/servers/ServersContext';

const navigation = {navigate: jest.fn()} as any;
const route = {} as any;

/**
 * Covers the "Possible Unhandled Promise Rejection" bug: enableBiometricUnlock/
 * disableBiometricUnlock are documented (session.ts) to resolve rather than
 * reject for every expected outcome, but the Switch's fire-and-forget
 * onValueChange handler is the last line of defense if that contract is ever
 * violated, so it needs its own coverage independent of session.ts's tests.
 */

// Settings also has the Developer Mode switch: these tests are about the biometric one
function biometricSwitches(tree: any) {
  return tree.root.findAll((node: any) => node.type === Switch && node.props.testID === 'biometric-unlock-switch');
}

function biometricSwitch(tree: any) {
  const [found] = biometricSwitches(tree);
  if (!found) {
    throw new Error('no biometric switch');
  }
  return found;
}

describe('SettingsScreen biometric toggle', () => {
  function setUp(overrides?: Partial<ReturnType<typeof useAuth>>) {
    const enableBiometricUnlock = jest.fn().mockResolvedValue('enabled');
    const disableBiometricUnlock = jest.fn().mockResolvedValue('disabled');
    (useAuth as jest.Mock).mockReturnValue({
      logout: jest.fn(),
      biometricsAvailable: true,
      biometricUnlockEnabled: false,
      enableBiometricUnlock,
      disableBiometricUnlock,
      // Settings > About asks the connected Engine for its version; left
      // pending here, since these tests are about the biometric switch
      client: {get: jest.fn(() => new Promise(() => {}))},
      ...overrides,
    });
    (useServers as jest.Mock).mockReturnValue({activeServer: {id: 's1', name: 'Home'}});
    const tree = renderer.create(<SettingsScreen navigation={navigation} route={route} />);
    return {tree, enableBiometricUnlock, disableBiometricUnlock};
  }

  it('enables biometric unlock on success with no error shown', async () => {
    const {tree, enableBiometricUnlock} = setUp();

    await act(async () => {
      biometricSwitch(tree).props.onValueChange(true);
    });

    expect(enableBiometricUnlock).toHaveBeenCalled();
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
    expect(texts.join(' ')).not.toMatch(/wrong|fail/i);
  });

  it('does not crash or leave an unhandled rejection when the prompt is cancelled', async () => {
    const enableBiometricUnlock = jest.fn().mockResolvedValue('cancelled');
    const {tree} = setUp({enableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(true);
    });

    expect(enableBiometricUnlock).toHaveBeenCalled();
    // cancelling is not an error - no error text should appear
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
    expect(texts.join(' ')).not.toMatch(/wrong|fail/i);
  });

  it('shows an error and recovers cleanly if enabling unexpectedly rejects', async () => {
    const enableBiometricUnlock = jest.fn().mockRejectedValue(new Error('Keystore write failed'));
    const {tree} = setUp({enableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(true);
    });

    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['Keystore write failed']));
    expect(biometricSwitch(tree).props.disabled).toBe(false);
  });

  it('disables biometric unlock cleanly', async () => {
    const {tree, disableBiometricUnlock} = setUp({biometricUnlockEnabled: true});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(false);
    });

    expect(disableBiometricUnlock).toHaveBeenCalled();
  });

  it('shows an error and recovers cleanly if disabling unexpectedly rejects', async () => {
    const disableBiometricUnlock = jest.fn().mockRejectedValue(new Error('boom'));
    const {tree} = setUp({biometricUnlockEnabled: true, disableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(false);
    });

    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['boom']));
  });

  it('does not render the biometric card when biometrics are unavailable', () => {
    const {tree} = setUp({biometricsAvailable: false});

    expect(biometricSwitches(tree)).toHaveLength(0);
  });

  it('does not render the biometric card when there is no sensor', () => {
    const {tree} = setUp({biometricsAvailable: false, biometricsUnavailableReason: 'no-hardware'});

    expect(biometricSwitches(tree)).toHaveLength(0);
  });

  it('shows a disabled switch and explains when no fingerprint is enrolled', () => {
    const {tree} = setUp({biometricsAvailable: false, biometricsUnavailableReason: 'not-enrolled'});

    expect(biometricSwitch(tree).props.disabled).toBe(true);
    expect(textOf(tree)).toMatch(/No fingerprint is enrolled/);
  });

  it('keeps showing an enabled lock after biometrics become unavailable', () => {
    const {tree} = setUp({
      biometricsAvailable: false,
      biometricsUnavailableReason: 'unavailable',
      biometricUnlockEnabled: true,
    });

    expect(biometricSwitch(tree).props.value).toBe(true);
    expect(biometricSwitch(tree).props.disabled).toBe(true);
  });

  it.each([
    ['not-enrolled', /No fingerprint is enrolled/],
    ['unavailable', /not available/],
    ['failed', /Could not save/],
  ])('explains an enable that ends in %s', async (result, message) => {
    const enableBiometricUnlock = jest.fn().mockResolvedValue(result);
    const {tree} = setUp({enableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(true);
    });

    expect(textOf(tree)).toMatch(message);
  });

  it('keeps the switch controlled by the stored state, not the tap', async () => {
    const enableBiometricUnlock = jest.fn().mockResolvedValue('cancelled');
    const {tree} = setUp({enableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(true);
    });

    expect(biometricSwitch(tree).props.value).toBe(false);
  });

  it('lets the lock be turned off after a password login when biometrics are unavailable', async () => {
    const {tree, disableBiometricUnlock} = setUp({
      biometricsAvailable: false,
      biometricsUnavailableReason: 'not-enrolled',
      biometricUnlockEnabled: true,
      passwordRecoveryAvailable: true,
    });

    expect(biometricSwitch(tree).props.disabled).toBe(false);
    expect(textOf(tree)).toMatch(/signed in with your password/);

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(false);
    });

    expect(disableBiometricUnlock).toHaveBeenCalled();
  });

  it('keeps the switch disabled without password proof when biometrics are unavailable', () => {
    const {tree} = setUp({
      biometricsAvailable: false,
      biometricsUnavailableReason: 'not-enrolled',
      biometricUnlockEnabled: true,
      passwordRecoveryAvailable: false,
    });

    expect(biometricSwitch(tree).props.disabled).toBe(true);
  });

  it('shows nothing when cancelling a disable', async () => {
    const disableBiometricUnlock = jest.fn().mockResolvedValue('cancelled');
    const {tree} = setUp({biometricUnlockEnabled: true, disableBiometricUnlock});

    await act(async () => {
      await biometricSwitch(tree).props.onValueChange(false);
    });

    expect(disableBiometricUnlock).toHaveBeenCalled();
    expect(textOf(tree)).not.toMatch(/wrong|fail|Could not/i);
  });
});

function textOf(tree: any): string {
  return tree.root
    .findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat()
    .filter(Boolean)
    .join(' ');
}
