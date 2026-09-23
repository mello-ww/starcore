import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import * as store from '../storage/preferences';
import type {ServerProfile} from './types';

/** A server `addAndActivate` just created and switched to, not yet
 * authenticated against - tracked here (rather than by each caller) so
 * both the onboarding wizard and the Settings "Add Server" flow get
 * back-out-and-resume support for free, without either needing to know
 * about the other. See `cancelPendingAdd`. */
interface PendingAdd {
  serverId: string;
  /** Whatever was active before this add - null only for the very first
   * server (onboarding), since there's nothing to switch back to. */
  previousServerId: string | null;
  name: string;
  baseUrl: string;
}

interface ServersContextValue {
  loading: boolean;
  servers: ServerProfile[];
  /** The currently selected server, or null before one has ever been
   * added/selected - see App.tsx, which shows ConnectScreen in that case. */
  activeServer: ServerProfile | null;
  /** Adds a server and makes it the active one in a single step - the
   * common case (the "Connect to StarCore" flow, first-run or "add
   * another server"). Resolves to the created server so a caller that
   * needs its id doesn't have to re-derive it from `servers`. Also records
   * it as `pendingAdd` - see `cancelPendingAdd`. */
  addAndActivate: (name: string, baseUrl: string) => Promise<ServerProfile>;
  switchTo: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The server currently mid-add (not yet authenticated), if any. */
  pendingAdd: PendingAdd | null;
  /** Backs out of `pendingAdd`: removes that just-added server (it was
   * never signed into, so keeping it would leave an orphaned duplicate
   * profile behind - `addServer` always appends, never updates in place)
   * and switches back to whatever was active before it, if anything.
   * Resolves to the name/address that were typed, so the caller can hand
   * them back to whichever screen it resumes on. */
  cancelPendingAdd: () => Promise<{name: string; address: string} | null>;
  /** Call once a pending add's server has actually been signed into, so a
   * later, unrelated sign-out doesn't still show a "back" option for it. */
  clearPendingAdd: () => void;
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
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);

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

  const addAndActivate = useCallback(
    async (name: string, baseUrl: string) => {
      const previousServerId = activeServerId;
      const server = await store.addServer(name, baseUrl);
      await store.setActiveServerId(server.id);
      setServers(await store.getServers());
      setActiveServerIdState(server.id);
      setPendingAdd({serverId: server.id, previousServerId, name: server.name, baseUrl: server.baseUrl});
      return server;
    },
    [activeServerId],
  );

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

  const cancelPendingAdd = useCallback(async () => {
    if (!pendingAdd) {
      return null;
    }
    const {serverId, previousServerId, name, baseUrl} = pendingAdd;
    setPendingAdd(null);
    await remove(serverId);
    if (previousServerId) {
      await switchTo(previousServerId);
    }
    return {name, address: baseUrl};
  }, [pendingAdd, remove, switchTo]);

  const clearPendingAdd = useCallback(() => setPendingAdd(null), []);

  const activeServer = useMemo(
    () => servers.find(server => server.id === activeServerId) ?? null,
    [servers, activeServerId],
  );

  const value: ServersContextValue = {
    loading,
    servers,
    activeServer,
    addAndActivate,
    switchTo,
    remove,
    pendingAdd,
    cancelPendingAdd,
    clearPendingAdd,
  };

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

export function useServers(): ServersContextValue {
  const value = useContext(ServersContext);
  if (!value) {
    throw new Error('useServers() must be used inside a ServersProvider');
  }
  return value;
}
