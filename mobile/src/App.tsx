import React, {useState} from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './auth/AuthContext';
import {OnboardingNavigator} from './navigation/OnboardingNavigator';
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
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <ServersProvider>
        <ServersGate />
      </ServersProvider>
    </SafeAreaProvider>
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
