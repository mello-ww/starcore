import {BottomTabBar, createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import React from 'react';
import {StatusBar} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {ConfigScreen} from '../screens/ConfigScreen';
import {ConnectScreen} from '../screens/ConnectScreen';
import {ConsoleScreen} from '../screens/ConsoleScreen';
import {HomeScreen} from '../screens/HomeScreen';
import {SatelliteDetailScreen} from '../screens/SatelliteDetailScreen';
import {SatellitesListScreen} from '../screens/SatellitesListScreen';
import {ServersScreen} from '../screens/ServersScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {useServers} from '../servers/ServersContext';
import {tokens, useAccent} from '../theme';
import {PhotoAlbumScreen} from '../photo/PhotoAlbumScreen';
import {PhotoConfigurationScreen} from '../photo/PhotoConfigurationScreen';
import {PhotoHomeScreen} from '../photo/PhotoHomeScreen';
import {PhotoTrashTab} from '../photo/PhotoTrashTab';
import {PhotoViewerScreen} from '../photo/PhotoViewerScreen';
import {MusicProvider} from '../music/MusicProvider';
import {FullPlayer} from '../music/player/FullPlayer';
import {MiniPlayer} from '../music/player/MiniPlayer';
import {AlbumScreen} from '../music/screens/AlbumScreen';
import {ArtistScreen} from '../music/screens/ArtistScreen';
import {DownloadsScreen} from '../music/screens/DownloadsScreen';
import {EqualizerScreen} from '../music/screens/EqualizerScreen';
import {MusicHomeScreen} from '../music/screens/MusicHomeScreen';
import {MusicSettingsScreen} from '../music/screens/MusicSettingsScreen';
import {PlaylistScreen} from '../music/screens/PlaylistScreen';
import {TrackListScreen} from '../music/screens/TrackListScreen';
import type {TrackListKind} from '../music/ui/navigation';

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
  /** The "Photo" Satellite is special-cased here rather than going through
   * SatelliteDetail's generic DeclarativeScreen - see PhotoHomeScreen's own
   * docstring and "Exposing a mobile interface" in docs/satellites.md. */
  PhotoHome: undefined;
  PhotoAlbum: {albumId: string; name: string};
  /** Reached from PhotoHomeScreen's gear icon, never a bottom-tab segment of
   * its own - see "Photo configuration... reachable via a settings entry"
   * in the task brief. */
  PhotoConfiguration: undefined;
  /** The Recycle bin, reached from inside the Albums section - see
   * PhotoAlbumsTab's own "Recycle bin" card. */
  PhotoTrash: undefined;
  PhotoViewer: {media: {id: string; mediaType: 'photo' | 'video'; duration: number | null}[]; startIndex: number};
  /** "Music" is special-cased the same way - see src/music/MusicProvider.tsx. */
  MusicHome: undefined;
  MusicAlbum: {id: string};
  MusicArtist: {id: string};
  MusicPlaylist: {id: string};
  MusicTracks: {kind: TrackListKind; id: string; title: string};
  MusicSettings: undefined;
  MusicEqualizer: undefined;
  MusicDownloads: undefined;
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
  headerStyle: {backgroundColor: tokens.palette.bg},
  headerTintColor: tokens.palette.text,
  headerTitleStyle: {fontFamily: tokens.type.title.fontFamily, fontWeight: '700' as const},
  headerShadowVisible: false,
  contentStyle: {backgroundColor: tokens.palette.bg},
};

/** "Satellites" tab's own stack: the list, then whichever Satellite the
 * user opens - see "Fully modular satellite mobile architecture" in the
 * task brief. Nothing here names a specific Satellite. */
function SatellitesStack() {
  return (
    <SatellitesStackNav.Navigator screenOptions={stackScreenOptions}>
      <SatellitesStackNav.Screen name="SatellitesList" component={SatellitesListScreen} options={{title: 'Satellites', headerShown: false}} />
      <SatellitesStackNav.Screen name="SatelliteDetail" component={SatelliteDetailScreen} />
      <SatellitesStackNav.Screen name="PhotoHome" component={PhotoHomeScreen} options={{title: 'Photos'}} />
      <SatellitesStackNav.Screen name="PhotoAlbum" component={PhotoAlbumScreen} />
      <SatellitesStackNav.Screen
        name="PhotoConfiguration"
        component={PhotoConfigurationScreen}
        options={{title: 'Photo configuration'}}
      />
      <SatellitesStackNav.Screen name="PhotoTrash" component={PhotoTrashTab} options={{title: 'Recycle bin'}} />
      <SatellitesStackNav.Screen
        name="PhotoViewer"
        component={PhotoViewerScreen}
        options={{headerShown: false, presentation: 'fullScreenModal'}}
      />
      <SatellitesStackNav.Screen name="MusicHome" component={MusicHomeScreen} options={{title: 'Music'}} />
      <SatellitesStackNav.Screen name="MusicAlbum" component={AlbumScreen} options={{title: 'Album'}} />
      <SatellitesStackNav.Screen name="MusicArtist" component={ArtistScreen} options={{title: 'Artist'}} />
      <SatellitesStackNav.Screen name="MusicPlaylist" component={PlaylistScreen} options={{title: 'Playlist'}} />
      <SatellitesStackNav.Screen name="MusicTracks" component={TrackListScreen} />
      <SatellitesStackNav.Screen name="MusicSettings" component={MusicSettingsScreen} options={{title: 'Music settings'}} />
      <SatellitesStackNav.Screen name="MusicEqualizer" component={EqualizerScreen} options={{title: 'Equalizer'}} />
      <SatellitesStackNav.Screen name="MusicDownloads" component={DownloadsScreen} options={{title: 'Downloads'}} />
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
      <SettingsStackNav.Screen name="SettingsHome" component={SettingsScreen} options={{title: 'Settings', headerShown: false}} />
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

// One Feather icon name per tab - "polish the 5 main mobile nav icons"
// without restructuring navigation, per the task brief. Feather was chosen
// (over Ionicons/MaterialIcons/etc, all bundled with react-native-vector-
// icons) purely for a consistent, thin-stroke look that matches Mission
// Control's own thin-line SVG icon set (see mission_control/page.js's
// RENAME_ICON/DELETE_ICON/etc, all stroke-only outlines).
const TAB_ICONS: Record<keyof MainTabParamList, string> = {
  Overview: 'home',
  Satellites: 'radio',
  Console: 'terminal',
  Config: 'sliders',
  Settings: 'settings',
};

function tabIcon(name: keyof MainTabParamList) {
  return ({color, size}: {color: string; size: number}) => <Icon name={TAB_ICONS[name]} color={color} size={size} />;
}

/**
 * Bottom tabs - exactly the five destinations in "New mobile bottom
 * navigation" in the task brief. Individual Satellites are never their own
 * tab; they live inside the Satellites tab's own stack. Music's mini-player
 * rides on top of the tab bar so it stays visible on every tab, and its one
 * audio player (MusicProvider) lives above all of them, so changing tabs or
 * screens never stops playback.
 */
export function MainTabs() {
  const {color: accent} = useAccent();
  return (
    <MusicProvider>
      <StatusBar barStyle="light-content" backgroundColor={tokens.palette.bg} />
      <Tab.Navigator
      tabBar={props => (
        <>
          <MiniPlayer />
          <BottomTabBar {...props} />
          <FullPlayer />
        </>
      )}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {backgroundColor: tokens.palette.bg, borderTopColor: tokens.palette.line},
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: tokens.palette.text2,
      }}>
      <Tab.Screen name="Overview" component={HomeScreen} options={{title: 'Home', tabBarIcon: tabIcon('Overview')}} />
      <Tab.Screen name="Satellites" component={SatellitesStack} options={{tabBarIcon: tabIcon('Satellites')}} />
      <Tab.Screen name="Console" component={ConsoleScreen} options={{tabBarIcon: tabIcon('Console')}} />
      <Tab.Screen name="Config" component={ConfigScreen} options={{tabBarIcon: tabIcon('Config')}} />
      <Tab.Screen name="Settings" component={SettingsStack} options={{tabBarIcon: tabIcon('Settings')}} />
      </Tab.Navigator>
    </MusicProvider>
  );
}
