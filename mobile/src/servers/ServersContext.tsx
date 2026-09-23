import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import * as store from '../storage/preferences';
import type {ServerProfile} from './types';

interface ServersContextValue {
  loading: boolean;
  servers: ServerProfile[];
  /** The currently selected server, or null before one has ever been
   * added/selected - see App.tsx, which shows ConnectScreen in that case. */
  activeServer: ServerProfile | null;
  /** Adds a server and makes it the active one in a single step - the
   * common case (the "Connect to StarCore" flow, first-run or "add
   * another server"). Resolves to the created server so a caller that
   * needs its id (e.g. App.tsx, tracking which server onboarding just
   * created) doesn't have to re-derive it from `servers`. */
  addAndActivate: (name: string, baseUrl: string) => Promise<ServerProfile>;
  switchTo: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const ServersContext = createContext<ServersContextValue | null>(null);

/**
 * Owns the list of StarCore servers this device knows about and which one
 * is active - the multi-server equivalent of the single `baseUrl` state
 * App.tsx used to keep itself. Everything below this (AuthProvider, and
 * therefore the whole signed-in app) is remounted whenever `activeServer`
 * changes (see App.tsx's `key={activeServer.id}`), so a server switch
 * always starts that server's session and satellite context fresh rather
 * than carrying over any state from the one before it.
 */
export function ServersProvider({children}: {children: React.ReactNode}) {
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [activeServerId, setActiveServerIdState] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      await store.migrateLegacySingleServer();
      const [loadedServers, activeId] = await Promise.all([store.getServers(), store.getActiveServerId()]);
      setServers(loadedServers);
      // a stored active id that no longer matches any server (e.g. it was
      // removed on a previous run) is treated as "none selected", not a crash
      setActiveServerIdState(loadedServers.some(server => server.id === activeId) ? activeId : null);
      setLoading(false);
    })();
  }, []);

  const addAndActivate = useCallback(async (name: string, baseUrl: string) => {
    const server = await store.addServer(name, baseUrl);
    await store.setActiveServerId(server.id);
    setServers(await store.getServers());
    setActiveServerIdState(server.id);
    return server;
  }, []);

  const switchTo = useCallback(async (id: string) => {
    await store.setActiveServerId(id);
    setActiveServerIdState(id);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await store.removeServer(id);
      const remaining = await store.getServers();
      setServers(remaining);
      if (activeServerId === id) {
        const next = remaining[0]?.id ?? null;
        await store.setActiveServerId(next);
        setActiveServerIdState(next);
      }
    },
    [activeServerId],
  );

  const activeServer = useMemo(
    () => servers.find(server => server.id === activeServerId) ?? null,
    [servers, activeServerId],
  );

  const value: ServersContextValue = {loading, servers, activeServer, addAndActivate, switchTo, remove};

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

export function useServers(): ServersContextValue {
  const value = useContext(ServersContext);
  if (!value) {
    throw new Error('useServers() must be used inside a ServersProvider');
  }
  return value;
}
