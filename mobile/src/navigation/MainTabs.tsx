import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import React from 'react';
import {ConfigScreen} from '../screens/ConfigScreen';
import {ConnectScreen} from '../screens/ConnectScreen';
import {ConsoleScreen} from '../screens/ConsoleScreen';
import {OverviewScreen} from '../screens/OverviewScreen';
import {SatelliteDetailScreen} from '../screens/SatelliteDetailScreen';
import {SatellitesListScreen} from '../screens/SatellitesListScreen';
import {ServersScreen} from '../screens/ServersScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {useServers} from '../servers/ServersContext';
import {colors} from '../theme';

export type MainTabParamList = {
  Overview: undefined;
  Satellites: undefined;
  Console: undefined;
  Config: undefined;
  Settings: undefined;
};

export type SatellitesStackParamList = {
  SatellitesList: undefined;
  SatelliteDetail: {name: string};
};

export type SettingsStackParamList = {
  SettingsHome: undefined;
  Servers: undefined;
  AddServer: {name?: string; address?: string} | undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const SatellitesStackNav = createNativeStackNavigator<SatellitesStackParamList>();
const SettingsStackNav = createNativeStackNavigator<SettingsStackParamList>();

const stackScreenOptions = {
  headerStyle: {backgroundColor: colors.surface},
  headerTintColor: colors.text,
  headerShadowVisible: false,
};

/** "Satellites" tab's own stack: the list, then whichever Satellite the
 * user opens - see "Fully modular satellite mobile architecture" in the
 * task brief. Nothing here names a specific Satellite. */
function SatellitesStack() {
  return (
    <SatellitesStackNav.Navigator screenOptions={stackScreenOptions}>
      <SatellitesStackNav.Screen name="SatellitesList" component={SatellitesListScreen} options={{title: 'Satellites'}} />
      <SatellitesStackNav.Screen name="SatelliteDetail" component={SatelliteDetailScreen} />
    </SatellitesStackNav.Navigator>
  );
}

/** "Settings" tab's own stack: app settings, then server management and
 * (reached from there) adding a server - with a real back button, per
 * "Server address screen" in the task brief. */
function SettingsStack() {
  const {addAndActivate} = useServers();
  return (
    <SettingsStackNav.Navigator screenOptions={stackScreenOptions}>
      <SettingsStackNav.Screen name="SettingsHome" component={SettingsScreen} options={{title: 'Settings'}} />
      <SettingsStackNav.Screen name="Servers" component={ServersScreen} options={{title: 'Servers'}} />
      <SettingsStackNav.Screen name="AddServer" options={{headerShown: false}}>
        {({navigation, route}) => (
          <ConnectScreen
            initialName={route.params?.name}
            initialAddress={route.params?.address}
            onBack={() => navigation.goBack()}
            onConnect={async (name, url) => {
              await addAndActivate(name, url);
              // addAndActivate makes the new server active, which remounts
              // AuthProvider/RootNavigator above this whole tab bar (see
              // App.tsx) - there is deliberately nothing left to navigate
              // back to once that happens. If this add is later backed out
              // of from the Auth page, App.tsx's ServersGate resumes this
              // exact screen (via `resumeAddServerParams`/`route.params`
              // above) with what was typed still filled in.
            }}
          />
        )}
      </SettingsStackNav.Screen>
    </SettingsStackNav.Navigator>
  );
}

/**
 * Bottom tabs - exactly the five destinations in "New mobile bottom
 * navigation" in the task brief. Individual Satellites are never their own
 * tab; they live inside the Satellites tab's own stack.
 */
export function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {backgroundColor: colors.surface, borderTopColor: colors.line},
        tabBarActiveTintColor: colors.azure,
        tabBarInactiveTintColor: colors.textFaint,
      }}>
      <Tab.Screen name="Overview" component={OverviewScreen} />
      <Tab.Screen name="Satellites" component={SatellitesStack} />
      <Tab.Screen name="Console" component={ConsoleScreen} />
      <Tab.Screen name="Config" component={ConfigScreen} />
      <Tab.Screen name="Settings" component={SettingsStack} />
    </Tab.Navigator>
  );
}
