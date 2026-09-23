import {DarkTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import React from 'react';
import {ServerAddressStep} from '../screens/onboarding/ServerAddressStep';
import {ServerNameStep} from '../screens/onboarding/ServerNameStep';
import {colors} from '../theme';

export type OnboardingStackParamList = {
  ServerName: {name?: string} | undefined;
  ServerAddress: {name: string; address?: string};
};

const Stack = createNativeStackNavigator<OnboardingStackParamList>();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.void,
    card: colors.surface,
    border: colors.line,
    text: colors.text,
    primary: colors.azure,
  },
};

/**
 * First-launch-only: name the server, then give its address - see "Fix the
 * first-launch onboarding navigation" in the task brief. A real
 * NativeStackNavigator (the same primitive the Satellites and Settings tabs
 * already use for their own in-section back nav - see MainTabs.tsx) so a
 * back button and Android hardware back both come for free, and each step
 * stays mounted underneath the other, so anything typed survives going
 * back and forward again without any extra state-lifting.
 *
 * Only ever rendered while no server is configured yet (see App.tsx); once
 * `onConnect` succeeds, ServersGate swaps this whole tree out for the
 * signed-in app (LoginScreen - the third page of this same conceptual
 * wizard, see its own "Back" button) - there's deliberately no "finish"
 * screen here.
 *
 * `initialName`/`initialAddress`/`startOnAddressStep` exist for exactly one
 * caller: App.tsx, resuming this wizard on the address step (with what was
 * already typed still filled in) when the user backs out of the Account/
 * Auth page it just handed off to - see "Fix the third-page (Account/Auth)
 * back navigation" in the task brief. `initialState` seeds BOTH routes into
 * the stack, not just the focused one, so "Server Address" still has a real
 * "Server Name" underneath it to go back to, exactly as if the user had
 * clicked through in this session.
 */
export function OnboardingNavigator({
  onConnect,
  initialName = '',
  initialAddress = '',
  startOnAddressStep = false,
}: {
  onConnect: (name: string, url: string) => void;
  initialName?: string;
  initialAddress?: string;
  startOnAddressStep?: boolean;
}) {
  const initialState = startOnAddressStep
    ? {
        index: 1,
        routes: [
          {name: 'ServerName' as const, params: {name: initialName}},
          {name: 'ServerAddress' as const, params: {name: initialName, address: initialAddress}},
        ],
      }
    : undefined;

  return (
    <NavigationContainer theme={navigationTheme} initialState={initialState}>
      <Stack.Navigator screenOptions={{headerShown: false}}>
        <Stack.Screen name="ServerName" component={ServerNameStep} initialParams={{name: initialName}} />
        <Stack.Screen name="ServerAddress">
          {props => <ServerAddressStep {...props} onConnect={onConnect} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
