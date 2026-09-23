import {NavigationContainer, DarkTheme} from '@react-navigation/native';
import React from 'react';
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

/** Everything *after* a server address is known (see App.tsx) - login vs.
 * the main tab shell, switched purely on `AuthContext`'s state. Neither
 * branch ever needs to be told which one to show by a screen reaching
 * into storage itself. */
export function RootNavigator() {
  const {state} = useAuth();

  if (state.status === 'loading') {
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void}}>
        <ActivityIndicator color={colors.azure} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      {state.status === 'signed-in' ? <MainTabs /> : <LoginScreen />}
    </NavigationContainer>
  );
}
