import React from 'react';
import renderer, {act} from 'react-test-renderer';
type Node = ReturnType<ReturnType<typeof renderer.create>['root']['findByType']>;
import {VaultUnlock} from '../src/vault/VaultUnlock';
import {isEnrolled} from '../src/vault/biometricUnlock';
import type {BiometricDeps, EnrollingBiometricApi} from '../src/vault/biometricUnlock';
import {FakeSecureStore} from './fakes';

// The unlock card of a full unlock turns biometric unlock on or off for this phone: the PIN that
// unlocks also enrols, only when the person asks and the phone can, and never for a grant.

function deps(available = true): BiometricDeps<EnrollingBiometricApi> & {api: Record<string, jest.Mock>} {
  const api = {
    enrollBiometrics: jest.fn(async () => 'key-1'),
    biometricChallenge: jest.fn(async () => 'CHALLENGE'),
    biometricUnlock: jest.fn(async () => null),
    revokeBiometrics: jest.fn(async () => undefined),
  };
  const signer = {
    isAvailable: jest.fn(async () => ({available, biometryType: available ? 'fingerprint' : 'none'})),
    keyExists: jest.fn(async () => false),
    createKey: jest.fn(async () => 'PUBLIC-KEY'),
    sign: jest.fn(async () => ({status: 'signed', signature: 'SIGNED'})),
    deleteKey: jest.fn(async () => undefined),
  };
  return {api, signer, store: new FakeSecureStore(), serverId: 'srv-1', provider: 'Safe'} as any;
}

const settle = () => act(async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
});

async function mount(props: Partial<React.ComponentProps<typeof VaultUnlock>>) {
  const withPin = jest.fn(async () => undefined);
  const onUnlocked = jest.fn();
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<VaultUnlock withPin={withPin} onUnlocked={onUnlocked} autoBiometrics={false} {...props} />);
  });
  await settle();
  return {tree, withPin, onUnlocked};
}

// the outermost node with the id: a switch passes its testID down to the native one
const byId = (tree: ReturnType<typeof renderer.create>, id: string) =>
  tree.root.findAll((node: Node) => node.props.testID === id && node.parent?.props.testID !== id);

async function unlockWith(tree: ReturnType<typeof renderer.create>, pin: string) {
  const field = tree.root.findByProps({accessibilityLabel: 'PIN'});
  await act(async () => field.props.onChangeText(pin));
  await act(async () => field.props.onSubmitEditing());
  await settle();
}

describe('biometric unlock from the unlock card', () => {
  it('turns it on with the PIN that unlocks, when asked', async () => {
    const biometricDeps = deps();
    const {tree, withPin, onUnlocked} = await mount({biometricDeps, offerBiometrics: true});
    const toggle = byId(tree, 'vault-remember-biometrics');
    expect(toggle).toHaveLength(1);
    await act(async () => toggle[0].props.onValueChange(true));
    await unlockWith(tree, '2468');
    expect(withPin).toHaveBeenCalledWith('2468');
    expect(biometricDeps.api.enrollBiometrics).toHaveBeenCalledWith('2468', 'PUBLIC-KEY', expect.any(String));
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(await isEnrolled(biometricDeps)).toBe(true);
  });

  it('leaves it off unless asked', async () => {
    const biometricDeps = deps();
    const {tree, onUnlocked} = await mount({biometricDeps, offerBiometrics: true});
    await unlockWith(tree, '2468');
    expect(biometricDeps.api.enrollBiometrics).not.toHaveBeenCalled();
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it('unlocks anyway when it can’t be turned on', async () => {
    const biometricDeps = deps();
    (biometricDeps.api.enrollBiometrics as jest.Mock).mockRejectedValueOnce(new Error('no'));
    const {tree, onUnlocked} = await mount({biometricDeps, offerBiometrics: true});
    await act(async () => byId(tree, 'vault-remember-biometrics')[0].props.onValueChange(true));
    await unlockWith(tree, '2468');
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(await isEnrolled(biometricDeps)).toBe(false);
  });

  it('is not offered for a grant, or on a phone without biometrics', async () => {
    for (const props of [{biometricDeps: deps()}, {biometricDeps: deps(false), offerBiometrics: true}]) {
      const {tree} = await mount(props);
      expect(byId(tree, 'vault-remember-biometrics')).toHaveLength(0);
      expect(byId(tree, 'vault-stop-biometrics')).toHaveLength(0);
      act(() => tree.unmount());
    }
  });

  it('turns it off on this phone and the server, then offers it again', async () => {
    const biometricDeps = deps();
    await biometricDeps.store.setItem('starcore.vault.biometricKeyId.srv-1.Safe', 'key-1');
    const {tree} = await mount({biometricDeps, offerBiometrics: true});
    expect(byId(tree, 'vault-remember-biometrics')).toHaveLength(0);
    await act(async () => byId(tree, 'vault-stop-biometrics')[0].props.onPress());
    await settle();
    expect(biometricDeps.api.revokeBiometrics).toHaveBeenCalledWith('key-1');
    expect(await isEnrolled(biometricDeps)).toBe(false);
    expect(byId(tree, 'vault-stop-biometrics')).toHaveLength(0);
    expect(byId(tree, 'vault-remember-biometrics')).toHaveLength(1);
  });
});
