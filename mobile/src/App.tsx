import React, {useEffect, useState} from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './auth/AuthContext';
import {ConnectScreen} from './screens/ConnectScreen';
import {RootNavigator} from './navigation/RootNavigator';
import {getServerUrl, setServerUrl} from './storage/preferences';

/**
 * Top-level composition: resolve a server address before anything else
 * runs, since `AuthProvider` needs one to even construct its API client -
 * see src/config.ts for why there's no compiled-in default. Everything
 * below `AuthProvider` (RootNavigator, every screen) can then assume a
 * server address and a session state both already exist.
 */
export default function App() {
  const [baseUrl, setBaseUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getServerUrl().then(setBaseUrl);
  }, []);

  if (baseUrl === undefined) {
    return null; // one frame of nothing while AsyncStorage resolves - not worth a spinner for
  }

  if (!baseUrl) {
    return (
      <SafeAreaProvider>
        <ConnectScreen
          onConnect={async url => {
            await setServerUrl(url);
            setBaseUrl(url.trim().replace(/\/+$/, ''));
          }}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AuthProvider baseUrl={baseUrl}>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
