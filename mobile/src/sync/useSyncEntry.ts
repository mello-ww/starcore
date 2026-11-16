import {useFocusEffect} from '@react-navigation/native';
import {useCallback, useState} from 'react';
import type {StarCoreClient} from '../api/client';
import {UiApi} from '../satellites/ui/api';
import {syncProvider} from '../satellites/ui/sync';
import {nativeSync, type SyncNative} from './native';
import {syncLine, type SyncLine} from './state';

/** The backup's entry in Settings: shown when this phone can back up and the server has a
 * media.sync provider (or the backup is already set up), with its state line. */
export interface SyncEntry {
  line: SyncLine;
}

/** Read each time Settings comes into view. */
function useEntry(native: SyncNative, client: StarCoreClient, serverId: string): SyncEntry | null {
  const [entry, setEntry] = useState<SyncEntry | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      (async () => {
        try {
          const [state, providers] = await Promise.all([native.state(serverId), new UiApi(client, serverId).providers()]);
          if (live) {
            const offered = state.configured || !!syncProvider(providers, 'media.sync');
            setEntry(offered ? {line: syncLine(state)} : null);
          }
        } catch {
          if (live) {
            setEntry(null);
          }
        }
      })();
      return () => {
        live = false;
      };
    }, [native, client, serverId]),
  );
  return entry;
}

const NATIVE = nativeSync();

/** Where the app has no background backup (another platform, or under Jest) there is no entry,
 * and nothing is read. Decided once, so the hooks called never change. */
export const useSyncEntry: (client: StarCoreClient, serverId: string) => SyncEntry | null = NATIVE
  ? (client, serverId) => useEntry(NATIVE, client, serverId)
  : () => null;
