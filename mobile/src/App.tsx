import React, {useEffect, useState} from 'react';
import {BackHandler, StatusBar, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './auth/AuthContext';
import {DeveloperModeProvider} from './developer/DeveloperModeContext';
import {OnboardingNavigator} from './navigation/OnboardingNavigator';
import {configureBackgroundFetch, triggerForegroundSync} from './photo/backgroundSyncTask';
import {RootNavigator} from './navigation/RootNavigator';
import {ConnectScreen} from './screens/ConnectScreen';
import {ServerListScreen} from './screens/ServerListScreen';
import {purgeLegacyOffline} from './satellites/ui/offline';
import {ServersProvider, useServers} from './servers/ServersContext';
import {AccentProvider, colors} from './theme';

type ResumeInfo = {name: string; address: string};

/**
 * Top-level composition. `ServersProvider` resolves which server (if any)
 * is active before anything else runs, since `AuthProvider` needs one to
 * even construct its API client - see src/servers/ServersContext.tsx and
 * src/config.ts for why there's no compiled-in default. Everything below
 * `AuthProvider` (RootNavigator, every screen) can then assume both a
 * server and a session state already exist.
 *
 * `GestureHandlerRootView` wraps everything - react-native-gesture-handler's
 * own docs require it at the true root for its gestures (PhotoViewerScreen's
 * pinch-to-zoom, PhotoLibraryTab's pinch-to-zoom grid density) to work
 * reliably on Android, not just wherever a gesture happens to be used.
 */
export default function App() {
  useEffect(() => {
    // Configures react-native-background-fetch's periodic schedule (see
    // photo/backgroundSyncTask.ts) and immediately runs one sync pass -
    // "immediate sync also triggered on app foreground" in the approved
    // design. Runs once per app start, independent of which server is
    // active or even whether one is configured yet (runBackgroundSync
    // iterates every server that has sync turned on), so this belongs above
    // ServersProvider/ServersGate rather than inside either.
    configureBackgroundFetch();
    triggerForegroundSync();
    // what the first offline store kept may hold fields pages now omit: removed at every start
    // until that succeeds, whichever server or screen is used next
    purgeLegacyOffline();
  }, []);

  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <SafeAreaProvider>
        <AccentProvider>
          <StatusBar barStyle="light-content" backgroundColor={colors.void} />
          <ServersProvider>
            <ActiveServerDeveloperMode>
              <ServersGate />
            </ActiveServerDeveloperMode>
          </ServersProvider>
        </AccentProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Developer Mode is remembered per server, so it follows whichever one is active. */
function ActiveServerDeveloperMode({children}: {children: React.ReactNode}) {
  const {activeServer} = useServers();
  return <DeveloperModeProvider serverId={activeServer?.id}>{children}</DeveloperModeProvider>;
}

function ServersGate() {
  const {
    loading,
    servers,
    activeServer,
    addAndActivate,
    pendingAdd,
    cancelPendingAdd,
    clearPendingAdd,
    deselectServer,
  } = useServers();

  // What was typed for whichever server is currently mid-add (see
  // ServersContext's `pendingAdd`), kept here - the one component that
  // survives switching between the OnboardingNavigator and RootNavigator
  // trees below - so it can be handed back to whichever screen the user
  // backed out of: OnboardingNavigator's address step for the very first
  // server, or MainTabs' "Add Server" screen for every one after that.
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null);

  // "Add server" opened from the server list (not first-run onboarding)
  const [addingFromList, setAddingFromList] = useState(false);

  useEffect(() => {
    if (!addingFromList) {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setAddingFromList(false);
      setResumeInfo(null);
      return true;
    });
    return () => subscription.remove();
  }, [addingFromList]);

  if (loading) {
    return null; // one frame of nothing while AsyncStorage resolves - not worth a spinner for
  }

  if (!activeServer && servers.length > 0) {
    // every cold start (and every "back" out of a server's lock or login
    // screen) lands here: nothing server-specific is mounted until the user
    // picks one
    if (addingFromList) {
      return (
        <View style={{flex: 1, backgroundColor: colors.void}}>
          <ConnectScreen
            initialName={resumeInfo?.name ?? ''}
            initialAddress={resumeInfo?.address ?? ''}
            onBack={() => {
              setAddingFromList(false);
              setResumeInfo(null);
            }}
            onConnect={async (name, url) => {
              setAddingFromList(false);
              await addAndActivate(name, url);
            }}
          />
        </View>
      );
    }
    return <ServerListScreen onAdd={() => setAddingFromList(true)} />;
  }

  if (!activeServer) {
    // first run, or every server has been removed - the name/address
    // wizard, with its own back button and Android hardware back (see
    // navigation/OnboardingNavigator.tsx); nothing to go back to *before*
    // this, since it's the very first thing the app shows
    return (
      <OnboardingNavigator
        initialName={resumeInfo?.name ?? ''}
        initialAddress={resumeInfo?.address ?? ''}
        startOnAddressStep={resumeInfo !== null}
        onConnect={(name, url) => addAndActivate(name, url)}
      />
    );
  }

  // `key` remounts AuthProvider (and therefore RootNavigator and every
  // screen beneath it) whenever the active server changes, so switching
  // servers always starts that server's session and satellite context
  // fresh - see "Multiple StarCore servers" in the task brief.
  return (
    <AuthProvider key={activeServer.id} baseUrl={activeServer.baseUrl} serverId={activeServer.id}>
      <RootNavigator
        resumeAddServerParams={resumeInfo ?? undefined}
        onBackToServerAddress={
          pendingAdd?.serverId === activeServer.id
            ? async () => {
                // added from the server list when other servers exist: the
                // add form reopens over the list. First-ever server: no
                // servers remain, so onboarding resumes by itself. Added
                // from Settings: the previous server is restored and
                // RootNavigator resumes Settings > Add Server.
                const reopenAddForm = pendingAdd.previousServerId === null && servers.length > 1;
                const info = await cancelPendingAdd();
                setResumeInfo(info);
                setAddingFromList(reopenAddForm);
              }
            : // an ordinary sign-in screen or lock screen: Back is the server list
              deselectServer
        }
        onBackToServerList={deselectServer}
        onSignedIn={() => {
          clearPendingAdd();
          setResumeInfo(null);
        }}
      />
    </AuthProvider>
  );
}
