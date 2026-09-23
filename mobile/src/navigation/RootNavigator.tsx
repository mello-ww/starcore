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
 * its own doc comment - only when this server was just created by the
 * onboarding wizard (App.tsx's ServersGate decides that, not this
 * component). `onSignedIn` fires once, the moment sign-in succeeds, purely
 * so ServersGate can stop treating this server as "still mid-onboarding"
 * afterwards; it's read here from AuthContext's own state rather than
 * duplicating any login logic.
 */
export function RootNavigator({
  onBackToServerAddress,
  onSignedIn,
}: {
  onBackToServerAddress?: () => void;
  onSignedIn?: () => void;
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

  return (
    <NavigationContainer theme={navigationTheme}>
      {state.status === 'signed-in' ? <MainTabs /> : <LoginScreen onBack={onBackToServerAddress} />}
    </NavigationContainer>
  );
}
