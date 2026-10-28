import React, {useEffect, useState} from 'react';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './auth/AuthContext';
import {OnboardingNavigator} from './navigation/OnboardingNavigator';
import {configureBackgroundFetch, triggerForegroundSync} from './photo/backgroundSyncTask';
import {RootNavigator} from './navigation/RootNavigator';
import {ServersProvider, useServers} from './servers/ServersContext';

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
  }, []);

  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <SafeAreaProvider>
        <ServersProvider>
          <ServersGate />
        </ServersProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ServersGate() {
  const {loading, activeServer, addAndActivate, pendingAdd, cancelPendingAdd, clearPendingAdd} = useServers();

  // What was typed for whichever server is currently mid-add (see
  // ServersContext's `pendingAdd`), kept here - the one component that
  // survives switching between the OnboardingNavigator and RootNavigator
  // trees below - so it can be handed back to whichever screen the user
  // backed out of: OnboardingNavigator's address step for the very first
  // server, or MainTabs' "Add Server" screen for every one after that.
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null);

  if (loading) {
    return null; // one frame of nothing while AsyncStorage resolves - not worth a spinner for
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
            ? async () => setResumeInfo(await cancelPendingAdd())
            : undefined
        }
        onSignedIn={() => {
          clearPendingAdd();
          setResumeInfo(null);
        }}
      />
    </AuthProvider>
  );
}
