import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ServerAddressStep} from '../src/screens/onboarding/ServerAddressStep';
import {ServerNameStep} from '../src/screens/onboarding/ServerNameStep';
import {LoginScreen} from '../src/screens/LoginScreen';

// testConnection talks to a real server - not relevant to navigation/back
// behavior, so it's stubbed the same way the rest of this suite stubs it.
jest.mock('../src/servers/testConnection', () => ({
  normalizeServerUrl: (url: string) => url,
  testConnection: jest.fn(),
}));

// LoginScreen reads `login`/`loginError` from AuthContext - stubbed here so
// these tests can mount it without a real AuthProvider/StarCoreClient.
jest.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({login: jest.fn(), loginError: null}),
}));

// This project's react-native Jest preset doesn't implement BackHandler
// under test - `addEventListener` isn't a function at all, which crashes
// the whole Jest worker process (the same class of incompatibility this
// suite already works around for react-native-screens - see
// jest.setup.js). Scoped to this file only, since no other suite touches
// BackHandler: everything else about `react-native` stays real.
let mockBackHandlerListener: (() => boolean) | null = null;
const mockAddEventListener = jest.fn((_eventName: string, handler: () => boolean) => {
  mockBackHandlerListener = handler;
  return {
    remove: () => {
      mockBackHandlerListener = null;
    },
  };
});

jest.mock('react-native', () => {
  // A Proxy rather than a spread: `react-native`'s own index exposes most
  // of its exports as lazy getters, and spreading (or otherwise touching
  // every key) forces all of them to resolve immediately, which pulls in
  // native modules (e.g. Settings) that don't exist under Jest and crash
  // the worker - the same failure this mock exists to work around for
  // BackHandler in the first place. The Proxy only ever intercepts the one
  // key this file cares about; everything else still resolves lazily,
  // exactly as it does for every other suite that doesn't mock
  // 'react-native' at all.
  const RN = jest.requireActual('react-native');
  return new Proxy(RN, {
    get(target, prop, receiver) {
      if (prop === 'BackHandler') {
        return {addEventListener: mockAddEventListener, removeEventListener: jest.fn()};
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

function fakeNavigation() {
  return {navigate: jest.fn(), goBack: jest.fn()} as any;
}

function pressHardwareBack() {
  return mockBackHandlerListener?.();
}

beforeEach(() => {
  mockAddEventListener.mockClear();
  mockBackHandlerListener = null;
});

/**
 * "Add a visible back button on the third page (Account/Auth)" - the task
 * brief's three requirements this file covers: values typed into onboarding
 * survive a round trip through route params (ServerName/ServerAddress), and
 * LoginScreen's new back button/hardware-back only appear when the screen
 * is told it's mid-onboarding (`onBack` provided) - exactly as before for
 * every other sign-in (a plain logout, or a server added via Settings).
 */
describe('onboarding back navigation', () => {
  describe('ServerNameStep', () => {
    it('prefills the name from route params when resuming the wizard', () => {
      const navigation = fakeNavigation();
      const route = {params: {name: 'Home'}} as any;

      const tree = renderer.create(<ServerNameStep navigation={navigation} route={route} />);

      const input = tree.root.findByProps({testID: 'onboarding-name-input'});
      expect(input.props.value).toBe('Home');
    });

    it('starts empty on a fresh first launch (no route params)', () => {
      const navigation = fakeNavigation();
      const route = {params: undefined} as any;

      const tree = renderer.create(<ServerNameStep navigation={navigation} route={route} />);

      const input = tree.root.findByProps({testID: 'onboarding-name-input'});
      expect(input.props.value).toBe('');
    });
  });

  describe('ServerAddressStep', () => {
    it('prefills the address from route params when resuming the wizard', () => {
      const navigation = fakeNavigation();
      const route = {params: {name: 'Home', address: '192.168.1.20:8090'}} as any;

      const tree = renderer.create(
        <ServerAddressStep navigation={navigation} route={route} onConnect={jest.fn()} />,
      );

      const input = tree.root.findByProps({testID: 'onboarding-address-input'});
      expect(input.props.value).toBe('192.168.1.20:8090');
    });

    it('still goes back to ServerName unchanged', () => {
      const navigation = fakeNavigation();
      const route = {params: {name: 'Home', address: ''}} as any;

      const tree = renderer.create(
        <ServerAddressStep navigation={navigation} route={route} onConnect={jest.fn()} />,
      );

      act(() => {
        tree.root.findByProps({testID: 'onboarding-back-button'}).props.onPress();
      });

      expect(navigation.goBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('LoginScreen', () => {
    // LoginScreen's back-handler wiring happens in a useEffect, which React
    // only flushes synchronously inside `act()` - without it, the effect
    // can still be pending when the test (and Jest's module teardown)
    // moves on, so every render here is wrapped.
    it('shows no back button when onBack is not provided (ordinary sign-in, unchanged)', () => {
      // `renderer` is untyped (see react-test-renderer.d.ts), so `tree` is
      // explicitly `any` here rather than implicitly.
      let tree: any;
      act(() => {
        tree = renderer.create(<LoginScreen />);
      });

      expect(tree!.root.findAllByProps({testID: 'login-back-button'})).toHaveLength(0);
    });

    it("shows a back button, styled/positioned like ServerAddressStep's, when onBack is provided", () => {
      const onBack = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(<LoginScreen onBack={onBack} />);
      });

      const button = tree!.root.findByProps({testID: 'login-back-button'});
      act(() => {
        button.props.onPress();
      });

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('does not wire Android hardware back when onBack is not provided', () => {
      act(() => {
        renderer.create(<LoginScreen />);
      });

      expect(mockAddEventListener).not.toHaveBeenCalled();
    });

    it('routes Android hardware back to onBack when provided', () => {
      const onBack = jest.fn();
      act(() => {
        renderer.create(<LoginScreen onBack={onBack} />);
      });

      act(() => {
        pressHardwareBack();
      });

      expect(onBack).toHaveBeenCalledTimes(1);
    });
  });
});
