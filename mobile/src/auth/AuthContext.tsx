import React, {createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState} from 'react';
import {AppState} from 'react-native';
import {AuthApi} from '../api/auth';
import {StarCoreClient} from '../api/client';
import {biometrics} from '../platform/biometrics';
import {deviceInfo} from '../platform/device';
import {secureStorage} from '../platform/secureStorage';
import type {BiometricAvailability, BiometricUnavailableReason} from '../platform/types';
import {AppLock, UnlockResult} from './appLock';
import {
  BIOMETRIC_ENABLED_KEY,
  BiometricDisableResult,
  BiometricEnableResult,
  Session,
  SessionManager,
  TOKEN_KEY,
} from './session';

// One per JS runtime, outliving AuthProvider remounts (server switches) so
// the background timer keeps running while no provider is mounted.
const appLock = new AppLock(biometrics);
AppState.addEventListener('change', status => appLock.handleAppStateChange(status));
const guardedBiometrics = appLock.guard(biometrics);

const UNAVAILABLE: BiometricAvailability = {available: false, biometryType: 'none'};

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
  /** Why biometrics can't be used right now, when `biometricsAvailable` is false. */
  biometricsUnavailableReason?: BiometricUnavailableReason;
  biometricUnlockEnabled: boolean;
  enableBiometricUnlock: () => Promise<BiometricEnableResult>;
  disableBiometricUnlock: () => Promise<BiometricDisableResult>;
  /** Signed in with biometric unlock on, and not yet unlocked in this
   * foreground session - the UI must show nothing but the lock screen. */
  locked: boolean;
  unlock: () => Promise<UnlockResult>;
  /** Biometrics can't be used right now, but the server password was just
   * entered, so the lock may be turned off without a fingerprint. */
  passwordRecoveryAvailable: boolean;
  /** The StarCore client for the server this provider was created for -
   * shared so every screen that needs to call the API (Overview, the
   * Satellites screen, Console, Config, ...) uses the exact same request
   * plumbing and token as auth itself, rather than each constructing its
   * own StarCoreClient. */
  client: StarCoreClient;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Wires `SessionManager` (the framework-free logic in session.ts) up to
 * React - one `SessionManager`/`StarCoreClient`/`AuthApi` per running app,
 * created once here and shared through context, so every screen asks the
 * same source of truth for "am I logged in" rather than each keeping its
 * own copy of that answer.
 *
 * `serverId` namespaces this provider's session storage (see
 * src/auth/session.ts) so multiple StarCore servers on the same device
 * never share or collide over a session token. App.tsx remounts this
 * component (via a React `key`) whenever the active server changes, so a
 * server switch always starts that server's own SessionManager fresh
 * rather than reusing state built for a different server.
 */
export function AuthProvider({
  baseUrl,
  serverId,
  children,
}: {
  baseUrl: string;
  serverId: string;
  children: React.ReactNode;
}) {
  const tokenKey = `${TOKEN_KEY}:${serverId}`;
  const biometricEnabledKey = `${BIOMETRIC_ENABLED_KEY}:${serverId}`;

  const client = useMemo(() => new StarCoreClient(baseUrl, () => secureStorage.getItem(tokenKey)), [baseUrl, tokenKey]);
  const api = useMemo(() => new AuthApi(client), [client]);
  const sessionManager = useMemo(
    () => new SessionManager(api, secureStorage, guardedBiometrics, deviceInfo, tokenKey, biometricEnabledKey),
    [api, tokenKey, biometricEnabledKey],
  );

  const [state, setState] = useState<AuthState>({status: 'loading'});
  const [loginError, setLoginError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<BiometricAvailability>(UNAVAILABLE);
  const [biometricUnlockEnabled, setBiometricUnlockEnabled] = useState(false);
  const [, rerenderOnLockChange] = useReducer((count: number) => count + 1, 0);

  useEffect(() => appLock.subscribe(rerenderOnLockChange), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // the preference is read before signed-in is reported, so a locked
      // session is never rendered unlocked for even one frame
      const [session, available, enabled] = await Promise.all([
        sessionManager.restore(),
        sessionManager.biometricAvailability(),
        sessionManager.biometricUnlockEnabled(),
      ]);
      if (cancelled) {
        return;
      }
      setAvailability(available);
      setBiometricUnlockEnabled(session ? enabled : false);
      setState(session ? {status: 'signed-in', session} : {status: 'signed-out'});
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionManager]);

  const refreshAvailability = useCallback(async () => {
    setAvailability(await sessionManager.biometricAvailability());
  }, [sessionManager]);

  useEffect(() => {
    // fingerprints may have been added or removed in Android Settings
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active') {
        refreshAvailability();
      }
    });
    return () => subscription.remove();
  }, [refreshAvailability]);

  const login = useCallback(
    async (username: string, password: string) => {
      setLoginError(null);
      try {
        const session = await sessionManager.login(username, password);
        // the server password is itself proof of presence for this server
        appLock.markUnlocked(serverId, true);
        setBiometricUnlockEnabled(await sessionManager.biometricUnlockEnabled());
        setState({status: 'signed-in', session});
      } catch (error: any) {
        setLoginError(error?.message || 'Could not log in.');
        throw error;
      }
    },
    [sessionManager, serverId],
  );

  const logout = useCallback(async () => {
    // the stored preference is kept (see SessionManager.logout); only the
    // in-memory flag is reset until the next sign-in re-reads it
    await sessionManager.logout();
    setBiometricUnlockEnabled(false);
    setState({status: 'signed-out'});
  }, [sessionManager]);

  const enableBiometricUnlock = useCallback(async (): Promise<BiometricEnableResult> => {
    if (state.status !== 'signed-in') {
      return 'failed';
    }
    const result = await sessionManager.enableBiometricUnlock();
    if (result === 'enabled') {
      // the prompt that just succeeded counts as this session's unlock
      appLock.markUnlocked(serverId);
      setBiometricUnlockEnabled(true);
    } else if (result === 'not-enrolled' || result === 'unavailable') {
      await refreshAvailability();
    }
    return result;
  }, [sessionManager, state, serverId, refreshAvailability]);

  const disableBiometricUnlock = useCallback(async (): Promise<BiometricDisableResult> => {
    if (state.status !== 'signed-in') {
      return 'failed';
    }
    const result = await sessionManager.disableBiometricUnlock({
      passwordVerified: appLock.hasPasswordProof(serverId),
    });
    if (result === 'disabled') {
      setBiometricUnlockEnabled(false);
    } else if (result === 'not-enrolled' || result === 'unavailable') {
      await refreshAvailability();
    }
    return result;
  }, [sessionManager, state, serverId, refreshAvailability]);

  const unlock = useCallback(async () => {
    const result = await appLock.unlock(serverId, 'Unlock StarCore');
    if (result === 'not-enrolled' || result === 'unavailable') {
      await refreshAvailability();
    }
    return result;
  }, [serverId, refreshAvailability]);

  const locked = state.status === 'signed-in' && biometricUnlockEnabled && !appLock.isUnlocked(serverId);

  const value: AuthContextValue = {
    state,
    login,
    logout,
    loginError,
    biometricsAvailable: availability.available,
    biometricsUnavailableReason: availability.available ? undefined : availability.reason,
    biometricUnlockEnabled,
    enableBiometricUnlock,
    disableBiometricUnlock,
    locked,
    unlock,
    passwordRecoveryAvailable:
      biometricUnlockEnabled && !availability.available && appLock.hasPasswordProof(serverId),
    client,
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
