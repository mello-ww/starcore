import {NavigationContainer} from '@react-navigation/native';
import React, {useEffect, useRef} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {LockScreen} from '../screens/LockScreen';
import {LoginScreen} from '../screens/LoginScreen';
import {colors, useAccent} from '../theme';
import {useNavigationTheme} from './navigationTheme';
import {MainTabs} from './MainTabs';

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
 *
 * Biometric app lock (AuthContext's `locked`): on a cold start the lock
 * screen is shown alone, so no signed-in screen mounts or fetches anything
 * before the unlock. When the app relocks after time in the background,
 * the lock screen covers the still-mounted navigator (so navigation state
 * survives) and the navigator is hidden from touch and accessibility.
 */
export function RootNavigator({
  onBackToServerAddress,
  onBackToServerList,
  onSignedIn,
  resumeAddServerParams,
}: {
  onBackToServerAddress?: () => void;
  /** Back from the lock screen to the server list. */
  onBackToServerList?: () => void;
  onSignedIn?: () => void;
  resumeAddServerParams?: {name: string; address: string};
}) {
  const {state, locked} = useAuth();
  const navigationTheme = useNavigationTheme();
  const {color: accent} = useAccent();
  const appShown = useRef(false);

  useEffect(() => {
    if (state.status === 'signed-in') {
      onSignedIn?.();
    }
    // Deliberately keyed on state.status only: onSignedIn must fire once per
    // sign-in, not again whenever the parent passes a new callback.
  }, [state.status]);

  if (state.status === 'loading') {
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void}}>
        <ActivityIndicator color={accent} size="large" />
      </View>
    );
  }

  if (locked && !appShown.current) {
    return <LockScreen onBack={onBackToServerList} />;
  }
  if (!locked) {
    appShown.current = true;
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
    <View style={styles.root}>
      <View
        style={styles.root}
        pointerEvents={locked ? 'none' : 'auto'}
        importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={locked}>
        <NavigationContainer theme={navigationTheme} initialState={initialState}>
          {state.status === 'signed-in' ? <MainTabs /> : <LoginScreen onBack={onBackToServerAddress} />}
        </NavigationContainer>
      </View>
      {locked && <LockScreen onBack={onBackToServerList} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
});
