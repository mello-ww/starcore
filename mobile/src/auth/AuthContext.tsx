import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {AuthApi} from '../api/auth';
import {StarCoreClient} from '../api/client';
import {biometrics} from '../platform/biometrics';
import {deviceInfo} from '../platform/device';
import {secureStorage} from '../platform/secureStorage';
import {Session, SessionManager, TOKEN_KEY} from './session';

type AuthState =
  | {status: 'loading'}
  | {status: 'signed-out'}
  | {status: 'signed-in'; session: Session};

interface AuthContextValue {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loginError: string | null;
  biometricsAvailable: boolean;
  biometricUnlockEnabled: boolean;
  enableBiometricUnlock: () => Promise<boolean>;
  disableBiometricUnlock: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Wires `SessionManager` (the framework-free logic in session.ts) up to
 * React - one `SessionManager`/`StarCoreClient`/`AuthApi` per running app,
 * created once here and shared through context, so every screen asks the
 * same source of truth for "am I logged in" rather than each keeping its
 * own copy of that answer.
 */
export function AuthProvider({baseUrl, children}: {baseUrl: string; children: React.ReactNode}) {
  const client = useMemo(() => new StarCoreClient(baseUrl, () => secureStorage.getItem(TOKEN_KEY)), [baseUrl]);
  const api = useMemo(() => new AuthApi(client), [client]);
  const sessionManager = useMemo(
    () => new SessionManager(api, secureStorage, biometrics, deviceInfo),
    [api],
  );

  const [state, setState] = useState<AuthState>({status: 'loading'});
  const [loginError, setLoginError] = useState<string | null>(null);
  const [biometricsAvailableState, setBiometricsAvailable] = useState(false);
  const [biometricUnlockEnabled, setBiometricUnlockEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [session, available] = await Promise.all([
        sessionManager.restore(),
        sessionManager.biometricsAvailable(),
      ]);
      if (cancelled) {
        return;
      }
      setBiometricsAvailable(available);
      if (session) {
        setBiometricUnlockEnabled(await sessionManager.biometricUnlockEnabled());
        setState({status: 'signed-in', session});
      } else {
        setState({status: 'signed-out'});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionManager]);

  const login = useCallback(
    async (username: string, password: string) => {
      setLoginError(null);
      try {
        const session = await sessionManager.login(username, password);
        setBiometricUnlockEnabled(false);
        setState({status: 'signed-in', session});
      } catch (error: any) {
        setLoginError(error?.message || 'Could not log in.');
        throw error;
      }
    },
    [sessionManager],
  );

  const logout = useCallback(async () => {
    await sessionManager.logout();
    setBiometricUnlockEnabled(false);
    setState({status: 'signed-out'});
  }, [sessionManager]);

  const enableBiometricUnlock = useCallback(async () => {
    if (state.status !== 'signed-in') {
      return false;
    }
    const enabled = await sessionManager.enableBiometricUnlock(state.session);
    setBiometricUnlockEnabled(enabled);
    return enabled;
  }, [sessionManager, state]);

  const disableBiometricUnlock = useCallback(async () => {
    if (state.status !== 'signed-in') {
      return;
    }
    await sessionManager.disableBiometricUnlock(state.session);
    setBiometricUnlockEnabled(false);
  }, [sessionManager, state]);

  const value: AuthContextValue = {
    state,
    login,
    logout,
    loginError,
    biometricsAvailable: biometricsAvailableState,
    biometricUnlockEnabled,
    enableBiometricUnlock,
    disableBiometricUnlock,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth() must be used inside an AuthProvider');
  }
  return value;
}
