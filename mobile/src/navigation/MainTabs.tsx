import {BottomTabBar, createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {SETTINGS_ICON} from '../components/SettingsButton';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {ConfigScreen} from '../screens/ConfigScreen';
import {ConnectScreen} from '../screens/ConnectScreen';
import {ConsoleScreen} from '../screens/ConsoleScreen';
import {HomeScreen} from '../screens/HomeScreen';
import {SatelliteDetailScreen} from '../screens/SatelliteDetailScreen';
import {SatelliteUiScreen} from '../screens/SatelliteUiScreen';
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
import {StatusHomeScreen} from '../status/StatusHomeScreen';
import {MusicProvider} from '../music/MusicProvider';
import {FullPlayer} from '../music/player/FullPlayer';
import {MiniPlayer} from '../music/player/MiniPlayer';
import {MusicDisc, MusicFlight} from '../music/player/MusicDisc';
import {TopBarSlot, TopBarSlotProvider} from '../components/TopBarSlot';
import {FloatingPlayerInsetProvider} from '../components/FloatingPlayerInset';
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
  /** Any Satellite's declarative interface (its ui.json, UI contract 1.0 -
   * see docs/ui-contract.md): one page of it, with the page's params.
   * `revision` is the one GET /api/satellites reported, so a cached copy of
   * exactly that document opens without a request. */
  SatelliteUi: {name: string; page?: string; params?: Record<string, any>; revision?: string | null};
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
  /** "Status" gets its own native screen too - see src/status/StatusHomeScreen.tsx. */
  StatusHome: undefined;
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
  // the same top-right slot every screen title has (Music's disc while something plays)
  headerRight: () => <TopBarSlot />,
};

/** "Satellites" tab's own stack: the list, then whichever Satellite the
 * user opens - see "Fully modular satellite mobile architecture" in the
 * task brief. Nothing here names a specific Satellite. */
function SatellitesStack() {
  return (
    <SatellitesStackNav.Navigator screenOptions={stackScreenOptions}>
      <SatellitesStackNav.Screen name="SatellitesList" component={SatellitesListScreen} options={{title: 'Satellites', headerShown: false}} />
      <SatellitesStackNav.Screen name="SatelliteDetail" component={SatelliteDetailScreen} />
      <SatellitesStackNav.Screen name="SatelliteUi" component={SatelliteUiScreen} />
      <SatellitesStackNav.Screen name="PhotoHome" component={PhotoHomeScreen} options={{title: ''}} />
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
      <SatellitesStackNav.Screen name="MusicHome" component={MusicHomeScreen} options={{title: ''}} />
      <SatellitesStackNav.Screen name="MusicAlbum" component={AlbumScreen} options={{title: 'Album'}} />
      <SatellitesStackNav.Screen name="MusicArtist" component={ArtistScreen} options={{title: 'Artist'}} />
      <SatellitesStackNav.Screen name="MusicPlaylist" component={PlaylistScreen} options={{title: 'Playlist'}} />
      <SatellitesStackNav.Screen name="MusicTracks" component={TrackListScreen} />
      <SatellitesStackNav.Screen name="MusicSettings" component={MusicSettingsScreen} options={{title: ''}} />
      <SatellitesStackNav.Screen name="MusicEqualizer" component={EqualizerScreen} options={{title: 'Equalizer'}} />
      <SatellitesStackNav.Screen name="MusicDownloads" component={DownloadsScreen} options={{title: 'Downloads'}} />
      <SatellitesStackNav.Screen name="StatusHome" component={StatusHomeScreen} options={{title: ''}} />
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
  Settings: SETTINGS_ICON,
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
  // Console and Config are developer tools: their tabs exist only in Developer Mode (their
  // routes stay as protected as ever - see DeveloperModeContext)
  const {enabled: developer} = useDeveloperMode();
  // the mini-player floats over the screens just above the tab bar, so it needs the bar's height
  const [tabBarHeight, setTabBarHeight] = useState(0);
  // and the screens leave its measured height (0 while it is hidden) at the end of their scrolling
  const [playerHeight, setPlayerHeight] = useState(0);
  return (
    <MusicProvider>
      <TopBarSlotProvider component={MusicDisc}>
      <FloatingPlayerInsetProvider value={playerHeight > 0 ? playerHeight + tokens.space.sm : 0}>
      <View style={styles.fill}>
      <Tab.Navigator
      tabBar={props => (
        <>
          <View onLayout={event => setTabBarHeight(event.nativeEvent.layout.height)}>
            <BottomTabBar {...props} />
          </View>
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
      {developer && <Tab.Screen name="Console" component={ConsoleScreen} options={{tabBarIcon: tabIcon('Console')}} />}
      {developer && <Tab.Screen name="Config" component={ConfigScreen} options={{tabBarIcon: tabIcon('Config')}} />}
      <Tab.Screen name="Settings" component={SettingsStack} options={{tabBarIcon: tabIcon('Settings')}} />
      </Tab.Navigator>
      {/* drawn over the screens rather than inside the tab bar's area, so what is underneath
          shows around its rounded edges */}
      <View
        pointerEvents="box-none"
        style={[styles.floating, {bottom: tabBarHeight}]}
        onLayout={event => setPlayerHeight(Math.round(event.nativeEvent.layout.height))}>
        <MiniPlayer />
      </View>
      <MusicFlight />
      </View>
      </FloatingPlayerInsetProvider>
      </TopBarSlotProvider>
    </MusicProvider>
  );
}

const styles = StyleSheet.create({fill: {flex: 1}, floating: {position: 'absolute', left: 0, right: 0}});
