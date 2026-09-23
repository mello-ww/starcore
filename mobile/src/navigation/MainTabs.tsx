import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import React from 'react';
import {ComingSoonScreen} from '../screens/ComingSoonScreen';
import {HomeScreen} from '../screens/HomeScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {colors} from '../theme';

export type MainTabParamList = {
  Home: undefined;
  LockedFolder: undefined;
  Files: undefined;
  Photos: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();

/**
 * Bottom tabs - the mobile navigation pattern the task brief calls for in
 * place of Mission Control's desktop sidebar (see `.sidebar` in
 * mission_control/style.css); a sidebar doesn't fit a phone's width, and a
 * bottom bar is the platform-idiomatic Android/iOS equivalent for a small,
 * fixed set of top-level destinations. Every tab exists now, even the ones
 * this block doesn't implement (Locked Folder, Files, Photos) - see
 * ComingSoonScreen - so later blocks add a screen's *content*, never a new
 * navigation entry.
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
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="LockedFolder" options={{title: 'Locked Folder'}}>
        {() => (
          <ComingSoonScreen
            title="Locked Folder"
            description="Locked Folder access is coming to the mobile app in a future update - unlock will use your fingerprint or face locally, then the same server-side unlock Mission Control uses."
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Files" options={{title: 'Files'}}>
        {() => (
          <ComingSoonScreen
            title="Files"
            description="Browsing, uploading and downloading files through File Explorer is coming to the mobile app in a future update."
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Photos" options={{title: 'Photos'}}>
        {() => (
          <ComingSoonScreen
            title="Photos"
            description="Your Photo Library, albums and map view are coming to the mobile app in a future update."
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
