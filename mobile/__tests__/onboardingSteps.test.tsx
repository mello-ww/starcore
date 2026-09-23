import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {ServerAddressStep} from '../src/screens/onboarding/ServerAddressStep';
import {ServerNameStep} from '../src/screens/onboarding/ServerNameStep';

jest.mock('../src/servers/testConnection', () => ({
  normalizeServerUrl: (input: string) =>
    /^https?:\/\//i.test(input.trim()) ? input.trim() : `http://${input.trim()}`,
  testConnection: jest.fn(),
}));

import {testConnection} from '../src/servers/testConnection';

function fakeNavigation() {
  return {navigate: jest.fn(), goBack: jest.fn()};
}

function prop(tree: any, testID: string) {
  return tree.root.findByProps({testID}).props;
}

function texts(tree: any): string[] {
  return tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
}

/**
 * The two onboarding steps themselves - see "Fix the first-launch
 * onboarding navigation" in the task brief. Each is exercised directly
 * against a fake `navigation` (navigate/goBack spies), rather than through
 * a real NativeStackNavigator - see onboarding.test.tsx's docstring for
 * why. This is what actually proves the bug is fixed: a real back button
 * that calls `navigation.goBack()`, the name typed in step one reaching
 * step two via route params, and a wrong/unreachable address never
 * quietly calling `onConnect`.
 */
describe('ServerNameStep (onboarding, step 1)', () => {
  it('passes the typed name forward when moving to the address step', () => {
    const navigation = fakeNavigation();
    const tree = renderer.create(<ServerNameStep {...({navigation, route: {key: 'a', name: 'ServerName'}} as any)} />);

    act(() => prop(tree, 'onboarding-name-input').onChangeText('Home'));
    act(() => tree.root.findByProps({title: 'Continue'}).props.onPress());

    expect(navigation.navigate).toHaveBeenCalledWith('ServerAddress', {name: 'Home'});
  });

  it('the name is optional - an empty one still moves forward', () => {
    const navigation = fakeNavigation();
    const tree = renderer.create(<ServerNameStep {...({navigation, route: {key: 'a', name: 'ServerName'}} as any)} />);

    act(() => tree.root.findByProps({title: 'Continue'}).props.onPress());

    expect(navigation.navigate).toHaveBeenCalledWith('ServerAddress', {name: ''});
  });
});

describe('ServerAddressStep (onboarding, step 2)', () => {
  beforeEach(() => {
    (testConnection as jest.Mock).mockReset();
  });

  function renderStep(name = 'Home', onConnect = jest.fn()) {
    const navigation = fakeNavigation();
    const tree = renderer.create(
      <ServerAddressStep
        {...({navigation, route: {key: 'b', name: 'ServerAddress', params: {name}}, onConnect} as any)}
      />,
    );
    return {tree, navigation, onConnect};
  }

  it('shows a clearly visible back button', () => {
    const {tree} = renderStep();

    expect(() => tree.root.findByProps({testID: 'onboarding-back-button'})).not.toThrow();
  });

  it('the back button returns to the name step (pops, does not restart the app)', () => {
    const {tree, navigation} = renderStep();

    act(() => tree.root.findByProps({testID: 'onboarding-back-button'}).props.onPress());

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('does not connect and shows a clear error when the server cannot be reached', async () => {
    (testConnection as jest.Mock).mockResolvedValue({ok: false, message: 'Could not reach StarCore.'});
    const {tree, onConnect} = renderStep();

    act(() => prop(tree, 'onboarding-address-input').onChangeText('10.0.0.5:9999'));
    await act(async () => {
      tree.root.findByProps({title: 'Connect'}).props.onPress();
    });

    expect(onConnect).not.toHaveBeenCalled();
    expect(texts(tree)).toEqual(expect.arrayContaining(['Could not reach StarCore.']));
    // still right here, editable - not "restart the application" to fix it
    expect(() => tree.root.findByProps({testID: 'onboarding-address-input'})).not.toThrow();
  });

  it('connects once the server is verified reachable, normalizing a bare address, using the name from step one', async () => {
    (testConnection as jest.Mock).mockResolvedValue({ok: true, resolvedBaseUrl: 'http://192.168.1.20:8090'});
    const {tree, onConnect} = renderStep('Home');

    act(() => prop(tree, 'onboarding-address-input').onChangeText('192.168.1.20:8090'));
    await act(async () => {
      tree.root.findByProps({title: 'Connect'}).props.onPress();
    });

    expect(onConnect).toHaveBeenCalledWith('Home', 'http://192.168.1.20:8090');
  });
});
