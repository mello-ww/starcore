import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {Button} from '../components/Button';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';
import {StarSwitch} from '../components/StarSwitch';
import {Surface} from '../components/Surface';
import {UiApi} from '../satellites/ui/api';
import type {CapabilityProvider} from '../satellites/ui/contract';
import {syncProvider} from '../satellites/ui/sync';
import {useServers} from '../servers/ServersContext';
import {tokens, useAccent} from '../theme';
import {nativeSync, type SyncChanges, type SyncFailure, type SyncFolder, type SyncState} from './native';
import {requestMediaAccess, type AccessOutcome} from './permissions';
import {setUpSync, SyncSetupError} from './setup';
import {failureReason, isPlainHttp, syncLine} from './state';

const {palette, space, type} = tokens;

/** How often the screen reads the backup's state while it is open. */
const REFRESH_MS = 2000;

const ACCESS_NOTICES: Record<Exclude<AccessOutcome, 'full'>, string> = {
  partial:
    'Only some photos and videos are allowed. A backup needs all of them: allow all photos and videos in this ' +
    "app's settings.",
  denied: 'A backup needs to read your photos and videos.',
  blocked: "A backup needs to read your photos and videos. Allow them in this app's settings.",
};
const ACCESS_TEXTS = new Set<string>(Object.values(ACCESS_NOTICES));

type Props = {route: {params?: {satellite?: string; capability?: string}}};

/**
 * The app's own sync screen (client capability device.media-sync): the background backup of the
 * phone's images and videos to the server's media.sync provider. Opened by a document's sync
 * action (for that document's own provider) or from Settings (the server's provider). The
 * document supplies nothing of it: the switches, folders and states are the app's own.
 */
export function MediaSyncScreen({route}: Props) {
  const capability = route.params?.capability ?? 'media.sync';
  const satellite = route.params?.satellite;
  const {client} = useAuth();
  const {activeServer} = useServers();
  const {color: accent} = useAccent();
  const native = useMemo(() => nativeSync(), []);
  const serverId = activeServer?.id ?? 'default';
  const origin = activeServer?.baseUrl ?? '';
  const api = useMemo(() => new UiApi(client, serverId), [client, serverId]);

  const [state, setState] = useState<SyncState | null>(null);
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [failures, setFailures] = useState<SyncFailure[]>([]);
  const [provider, setProvider] = useState<CapabilityProvider | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsSettings, setNeedsSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!native) {
      return;
    }
    try {
      const next = await native.state(serverId);
      if (!mounted.current) {
        return;
      }
      setState(next);
      if (next.configured && (next.failed ?? 0) > 0) {
        const failed = await native.failures(serverId);
        if (mounted.current) {
          setFailures(failed);
        }
      } else {
        setFailures([]);
      }
    } catch {
      // the next refresh tries again
    }
  }, [native, serverId]);

  const loadFolders = useCallback(async () => {
    if (!native) {
      return;
    }
    try {
      const found = await native.folders();
      if (mounted.current) {
        setFolders(found);
      }
    } catch {
      setFolders([]);
    }
  }, [native]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let live = true;
    api.providers().then(providers => {
      if (live) {
        setProvider(syncProvider(providers, capability, satellite));
      }
    });
    return () => {
      live = false;
    };
  }, [api, capability, satellite]);

  const access = state?.access;
  useEffect(() => {
    if (access === 'full') {
      // access given in the system settings settles what was asked of the person
      setNeedsSettings(false);
      setNotice(current => (current && ACCESS_TEXTS.has(current) ? null : current));
    }
  }, [access]);

  // each finished run follows new media, so the folders' counts are read again then
  const lastRun = state?.lastRun;
  useEffect(() => {
    if (access === 'full') {
      loadFolders();
    }
  }, [access, lastRun, loadFolders]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (error: any) {
      setNotice(error instanceof SyncSetupError ? error.message : error?.message || 'Something went wrong.');
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
      await refresh();
    }
  };

  /** Asks for media access when it is missing; false when the backup can't go on. */
  const ensureAccess = async (): Promise<boolean> => {
    if (!native || state?.access === 'full') {
      return true;
    }
    const outcome = await requestMediaAccess(native.sdk);
    if (outcome === 'full') {
      setNeedsSettings(false);
      return true;
    }
    setNotice(ACCESS_NOTICES[outcome]);
    setNeedsSettings(outcome !== 'denied');
    return false;
  };

  const setUp = () =>
    run(async () => {
      if (!native || !provider) {
        throw new SyncSetupError('This server has no backup for this phone.');
      }
      if (!(await ensureAccess())) {
        return;
      }
      await setUpSync({client, native, serverId, origin, capability, provider});
      await loadFolders();
    });

  const change = (changes: SyncChanges) => run(async () => native && native.update(serverId, changes));

  const toggle = (on: boolean) => {
    if (!on) {
      return change({enabled: false});
    }
    if (!state?.configured) {
      return setUp();
    }
    return run(async () => {
      if (await ensureAccess()) {
        await native?.update(serverId, {enabled: true});
      }
    });
  };

  const toggleFolder = (id: string, on: boolean) => {
    const excluded = new Set(state?.excluded ?? []);
    if (on) {
      excluded.delete(id);
    } else {
      excluded.add(id);
    }
    return change({excluded: [...excluded].sort()});
  };

  if (!native) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Surface>
          <Text style={type.body}>This phone can't back up from this app.</Text>
        </Surface>
      </ScrollView>
    );
  }
  if (!state || provider === undefined) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={accent} />
      </View>
    );
  }

  const configured = state.configured;
  const enabled = configured && !!state.enabled;
  const line = syncLine(state);
  const signedOut = enabled && state.access === 'full' && line.text === 'Sign in again';
  const permission = enabled && state.access !== 'full';
  const excluded = new Set(state.excluded ?? []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!provider && !configured ? (
        <Surface>
          <Text style={type.body} testID="sync-no-provider">
            This server has no backup for this phone.
          </Text>
        </Surface>
      ) : (
        <Surface style={styles.card}>
          <View style={styles.row}>
            <Icon name="upload-cloud" size={20} color={accent} />
            <View style={styles.rowText}>
              <Text style={type.title}>Back up this phone</Text>
              <Text style={type.caption}>
                Sends new photos and videos to this server in the background. Nothing is ever deleted from this phone.
              </Text>
            </View>
            <StarSwitch value={enabled} onValueChange={toggle} disabled={busy} testID="sync-enabled" />
          </View>
          <Text style={[styles.line, line.tone === 'attention' && styles.attention]} testID="sync-line">
            {line.text}
          </Text>
          {configured && (state.backedUp ?? 0) > 0 && (
            <Text style={type.caption} testID="sync-count">
              {state.backedUp} backed up from this phone
            </Text>
          )}
          {isPlainHttp(state.origin ?? origin) && (
            <Text style={styles.warning} testID="sync-http">
              This server is reached over plain HTTP: what is sent can be read on your network.
            </Text>
          )}
          {notice && (
            <Text style={styles.notice} testID="sync-notice">
              {notice}
            </Text>
          )}
          {(needsSettings || permission) && (
            <Button
              title="Open app settings"
              variant="secondary"
              onPress={() => Linking.openSettings()}
              testID="sync-open-settings"
            />
          )}
          {permission && <Button title="Allow access" onPress={() => toggle(true)} disabled={busy} testID="sync-allow" />}
          {signedOut && provider && <Button title="Sign in again" onPress={setUp} disabled={busy} testID="sync-sign-in" />}
          {enabled && !permission && !signedOut && (
            <Button
              title="Back up now"
              variant="secondary"
              onPress={() => run(() => native.runNow(serverId))}
              disabled={busy || !!state.running}
              testID="sync-now"
            />
          )}
        </Surface>
      )}

      {configured && (
        <Surface style={styles.card}>
          <Text style={type.title}>When</Text>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={type.label}>Use mobile data</Text>
              <Text style={type.caption}>Off: only on Wi-Fi.</Text>
            </View>
            <StarSwitch
              value={!!state.mobileData}
              onValueChange={value => change({mobileData: value})}
              disabled={busy}
              testID="sync-mobile-data"
            />
          </View>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={type.label}>Only while charging</Text>
              <Text style={type.caption}>Never on a low battery either way.</Text>
            </View>
            <StarSwitch
              value={!!state.charging}
              onValueChange={value => change({charging: value})}
              disabled={busy}
              testID="sync-charging"
            />
          </View>
        </Surface>
      )}

      {configured && state.access === 'full' && (
        <Surface style={styles.card}>
          <Text style={type.title}>Folders</Text>
          <Text style={type.caption}>Every folder is backed up unless you turn it off, new ones included.</Text>
          {folders.length === 0 ? (
            <Text style={type.caption}>No photos or videos on this phone yet.</Text>
          ) : (
            folders.map(folder => (
              <View key={folder.id} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={type.label}>{folder.name}</Text>
                  <Text style={type.caption}>
                    {folder.count} {folder.count === 1 ? 'item' : 'items'}
                    {folder.path ? ` - ${folder.path}` : ''}
                  </Text>
                </View>
                <StarSwitch
                  value={!excluded.has(folder.id)}
                  onValueChange={value => toggleFolder(folder.id, value)}
                  disabled={busy}
                  testID={`sync-folder-${folder.id}`}
                />
              </View>
            ))
          )}
        </Surface>
      )}

      {configured && failures.length > 0 && (
        <Surface style={styles.card}>
          <Text style={type.title}>Not backed up</Text>
          {failures.map(item => (
            <View key={item.id} style={styles.failure} testID="sync-failure">
              <Text style={type.label} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={type.caption}>
                {failureReason(item.reason)}
                {item.folder ? ` - ${item.folder}` : ''}
              </Text>
            </View>
          ))}
          {(state.failed ?? 0) > failures.length && (
            <Text style={type.caption}>and {(state.failed ?? 0) - failures.length} more</Text>
          )}
          <Button
            title="Try again"
            variant="secondary"
            onPress={() => run(() => native.retry(serverId))}
            disabled={busy}
            testID="sync-retry"
          />
        </Surface>
      )}
      <FloatingPlayerSpacer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  center: {alignItems: 'center', justifyContent: 'center'},
  content: {padding: space.lg, paddingBottom: space.xxl, gap: space.md},
  card: {gap: space.md},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  rowText: {flex: 1, gap: space.xs},
  line: {...type.label},
  attention: {color: palette.warn},
  warning: {color: palette.warn, fontSize: 13},
  notice: {color: palette.danger, fontSize: 13},
  failure: {gap: 2},
});
