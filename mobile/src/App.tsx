import React, {useState} from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './auth/AuthContext';
import {OnboardingNavigator} from './navigation/OnboardingNavigator';
import {RootNavigator} from './navigation/RootNavigator';
import {ServersProvider, useServers} from './servers/ServersContext';

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
  const {loading, activeServer, addAndActivate, remove} = useServers();

  // What's already been typed into the onboarding wizard, kept here (the
  // one component that survives switching between the OnboardingNavigator
  // and RootNavigator trees below) purely so it can be handed back to
  // OnboardingNavigator if the user backs out of the Account/Auth
  // (LoginScreen) step it hands off to - see "Add a visible back button on
  // the third page" in the task brief.
  const [pendingName, setPendingName] = useState('');
  const [pendingAddress, setPendingAddress] = useState('');
  // The id of the server onboarding itself just created, so RootNavigator
  // only gets a "back to address" handler for that server - never for one
  // reached through the separate Settings "Add Server" flow (MainTabs.tsx),
  // and never once the user has actually signed in.
  const [onboardingServerId, setOnboardingServerId] = useState<string | null>(null);
  const [resumeOnAddressStep, setResumeOnAddressStep] = useState(false);

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
        initialName={pendingName}
        initialAddress={pendingAddress}
        startOnAddressStep={resumeOnAddressStep}
        onConnect={async (name, url) => {
          setPendingName(name);
          setPendingAddress(url);
          const server = await addAndActivate(name, url);
          setOnboardingServerId(server.id);
          setResumeOnAddressStep(false);
        }}
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
        onBackToServerAddress={
          activeServer.id === onboardingServerId
            ? async () => {
                // Not yet signed in to this just-created server - treat
                // "back" as if it was never added, rather than leaving an
                // orphaned, unauthenticated ServerProfile behind (storage
                // always appends on addServer, it never updates in place).
                // Removing the active server drops ServersGate back into
                // the `!activeServer` branch above on the next render,
                // straight onto the address step with what was typed still
                // filled in.
                setResumeOnAddressStep(true);
                setOnboardingServerId(null);
                await remove(activeServer.id);
              }
            : undefined
        }
        onSignedIn={() => setOnboardingServerId(null)}
      />
    </AuthProvider>
  );
}
