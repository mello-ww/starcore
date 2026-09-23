import {NavigationContainer, DarkTheme} from '@react-navigation/native';
import React, {useEffect} from 'react';
import {ActivityIndicator, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {LoginScreen} from '../screens/LoginScreen';
import {colors} from '../theme';
import {MainTabs} from './MainTabs';

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
 * Everything *after* a server address is known (see App.tsx) - login vs.
 * the main tab shell, switched purely on `AuthContext`'s state. Neither
 * branch ever needs to be told which one to show by a screen reaching
 * into storage itself.
 *
 * `onBackToServerAddress` is passed through unchanged to LoginScreen - see
 * its own doc comment - only when this server was just created and not yet
 * signed into (App.tsx's ServersGate decides that via ServersContext's
 * `pendingAdd`, not this component). `onSignedIn` fires once, the moment
 * sign-in succeeds, purely so ServersGate can stop treating this server as
 * "still mid-add" afterwards; it's read here from AuthContext's own state
 * rather than duplicating any login logic.
 *
 * `resumeAddServerParams` is only set when a server added via the Settings
 * "Add Server" screen was just backed out of: that server is already
 * signed in (it was active before the add was attempted), so MainTabs
 * renders straight away, and `initialState` seeds it to open directly on
 * Settings > Servers > Add Server with what was typed still filled in,
 * instead of its usual Overview tab.
 */
export function RootNavigator({
  onBackToServerAddress,
  onSignedIn,
  resumeAddServerParams,
}: {
  onBackToServerAddress?: () => void;
  onSignedIn?: () => void;
  resumeAddServerParams?: {name: string; address: string};
}) {
  const {state} = useAuth();

  useEffect(() => {
    if (state.status === 'signed-in') {
      onSignedIn?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  if (state.status === 'loading') {
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void}}>
        <ActivityIndicator color={colors.azure} size="large" />
      </View>
    );
  }

  const initialState = resumeAddServerParams
    ? {
        index: 4,
        routes: [
          {name: 'Overview' as const},
          {name: 'Satellites' as const},
          {name: 'Console' as const},
          {name: 'Config' as const},
          {
            name: 'Settings' as const,
            state: {
              index: 2,
              routes: [
                {name: 'SettingsHome' as const},
                {name: 'Servers' as const},
                {name: 'AddServer' as const, params: resumeAddServerParams},
              ],
            },
          },
        ],
      }
    : undefined;

  return (
    <NavigationContainer theme={navigationTheme} initialState={initialState}>
      {state.status === 'signed-in' ? <MainTabs /> : <LoginScreen onBack={onBackToServerAddress} />}
    </NavigationContainer>
  );
}
