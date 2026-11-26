import {useIsFocused} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator, BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {Glyph, GlyphIcons} from '../components/Glyph';
import {useAuth} from '../auth/AuthContext';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {useAppActive} from '../hooks/useAppActive';
import {useServers} from '../servers/ServersContext';
import {UiApi} from '../satellites/ui/api';
import {
  findProvider, formatValue, isIconName, isSafeRoute, isVisible, missingRequirements, resolve, resolveTemplate,
  type CapabilityProvider, type Providers, type Scope, type UiAction, type UiDocument, type UiSource,
} from '../satellites/ui/contract';
import {SatellitesApi} from '../satellites/api';
import type {SatelliteSummary} from '../satellites/types';
import {MemoryImages} from '../satellites/ui/memoryImages';
import {MediaPicker, type MediaReference, type PickRequest} from '../satellites/ui/MediaPicker';
import {ChooseSheet} from '../satellites/ui/ChooseSheet';
import {runChoose, type ChooseAnswer, type ChooseOffer} from '../satellites/ui/choose';
import {RevealSecret, SecretPrompt} from '../satellites/ui/SecretPrompt';
import {askSecrets, bodyWithSecrets, revealFrom, type SecretAsk} from '../satellites/ui/secrets';
import {VirtualMediaGrid} from '../satellites/ui/MediaGrid';
import {hasPagedList, VirtualListPage} from '../satellites/ui/VirtualListPage';
import {mergeItem} from '../satellites/ui/rows';
import {opensSharedInterface} from './HomeScreen';
import {uiPreferences} from '../satellites/ui/preferences';
import {
  collectionKey, forgetOfflineSatellite, forgetOfflineServer, offlinePlan, offlineStateKeys, OfflineStore, sessionScope,
  tidyOffline,
  type GridPages, type OfflineEntry,
} from '../satellites/ui/offline';
import {runSecure, secureRunner, type GrantRequest, type SecurePrompt, type SecurePromptProps} from '../satellites/ui/secure';
import {SYNC_SCREENS, syncTarget} from '../satellites/ui/sync';
import {runOffline} from '../media/offlineAction';
import {VaultApi} from '../vault/api';
import {attachGate, createVaultGate, protectedProvider, type GateAttachment, type GateState} from '../vault/gate';
import {VAULT_GRANT_PROMPT} from '../vault/VaultGrantPrompt';
import {VaultUnlock} from '../vault/VaultUnlock';
import {useVault} from '../vault/useVault';
import {privacy} from '../platform/privacy';
import {
  canOpenFiles,
  canSaveFiles,
  canShareFiles,
  canUploadFiles,
  fileName,
  openFile,
  pickFiles,
  saveFile,
  shareFile,
  uploadFile,
} from '../files';
import {runUploads, uploadReport} from '../files/upload';
import {BlockContext, confirmAction, UiBlocks, UiPageBlocks} from '../satellites/ui/UiBlocks';
import {TOUCH_TARGET, tokens, useAccent} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {FloatingPlayerSpacer, useFloatingPlayerInset} from '../components/FloatingPlayerInset';
import {useOptionalAudioHost} from '../media/AudioHost';
import type {PagedPlay} from '../media/handover';

const {palette, radii, space, type} = tokens;

type Props = NativeStackScreenProps<SatellitesStackParamList, 'SatelliteUi'>;

/** The app's own prompts for the secure action (1.2), by capability. */
const SECURE_PROMPTS: SecurePrompt[] = [VAULT_GRANT_PROMPT];

/** The Satellite `wanted` when its manifest says it is a section of `host` (the section action, 1.2). */
function hostedSatellite(satellites: SatelliteSummary[] | null, host: string, wanted: unknown): SatelliteSummary | null {
  if (typeof wanted !== 'string' || !wanted) {
    return null;
  }
  return satellites?.find(other => other.section_of === host && other.name === wanted) ?? null;
}

/** Whether this app opens a Satellite: it does when the Satellite has a shared interface. */
function opensHosted(target: SatelliteSummary | null): boolean {
  return Boolean(target && opensSharedInterface(target));
}

/**
 * A protected document (1.2) while its store is locked: the app's own unlock card - the PIN, and
 * biometrics when this phone turned them on for the provider - asking the provider's unlock for
 * this session. The PIN goes nowhere but to that route. With `onForgot` (the document names a
 * forgot page), it offers "Forgot your PIN?".
 */
function LockedDocument({
  provider,
  title,
  onUnlocked,
  onForgot,
}: {
  provider: CapabilityProvider;
  title: string;
  onUnlocked: () => void;
  onForgot?: () => void;
}) {
  const {api, biometricDeps} = useVault(provider);
  const withPin = useCallback((pin: string) => api.unlock(pin), [api]);
  return (
    <VaultUnlock
      title={`${title} is locked`}
      intro="Unlock it to see what it holds. It locks again when you leave it."
      biometricPrompt={`Unlock ${title}`}
      withPin={withPin}
      biometricDeps={biometricDeps}
      offerBiometrics
      onUnlocked={onUnlocked}
      onForgot={onForgot}
    />
  );
}

/** Calls `load` now and every `source.refresh` seconds while `active`. */
function usePolling(source: UiSource | undefined, active: boolean, load: () => void, paused: () => boolean) {
  useEffect(() => {
    if (!active || !source?.refresh) {
      return;
    }
    const timer = setInterval(() => {
      if (!paused()) {
        load();
      }
    }, Math.max(2, source.refresh) * 1000);
    return () => clearInterval(timer);
  }, [active, source, load, paused]);
}

/**
 * Any Satellite's declarative interface (its ui.json - see
 * docs/ui-contract.md), drawn with this app's own components. This screen
 * knows the contract, never a Satellite: a new one that ships a ui.json
 * works here with no change to the app.
 *
 * Top-level pages (the document's navigation) are tabs within one screen;
 * a detail page is pushed as another instance of this screen, so Android's
 * back gesture works as everywhere else. Live pages refresh only while the
 * screen is focused and the app is in the foreground.
 *
 * A protected document (1.2) shows nothing before its store's own status says what may: the
 * setup page, the app's unlock card, or the page once it is open (src/vault/gate.ts). It keeps
 * nothing - no offline page, no share, images from memory only - and can't be captured.
 */
export function SatelliteUiScreen({route, navigation}: Props) {
  const {name, page: requestedPage, params = {}, revision} = route.params;
  const {client, state: authState} = useAuth();
  const sessionToken = authState?.status === 'signed-in' ? authState.session.token : null;
  const {activeServer} = useServers();
  const {enabled: developer} = useDeveloperMode();
  const {color: accent, onColor} = useAccent();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const live = focused && appActive;
  const api = useMemo(() => new UiApi(client, activeServer?.id ?? 'default'), [client, activeServer?.id]);
  // what the person chooses here (a grid's size), remembered for this server and Satellite
  const preferences = useMemo(() => uiPreferences(activeServer?.id ?? 'default', name), [activeServer?.id, name]);
  // the app's shared audio host: what a document's play action plays through (media.audio)
  const audio = useOptionalAudioHost();
  // notices sit above the floating player while it shows, not behind it
  const playerInset = useFloatingPlayerInset();

  const [document, setDocument] = useState<UiDocument | null>(null);
  const [offline, setOffline] = useState(false);
  const [providers, setProviders] = useState<Providers>({});
  // the Satellites this one may host (section_of), for the section action (1.2) - only fetched
  // for a document that has one
  const [satellites, setSatellites] = useState<SatelliteSummary[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  // true when StarCore could not be reached at all; false when it answered with an error
  const [unreachable, setUnreachable] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<Record<string, any>>({});
  const [header, setHeader] = useState<any>(null);
  // a choice's selections, for the page they were made on; the page's own defaults otherwise
  const [choices, setChoices] = useState<{page: string | undefined; values: Record<string, any>}>({page: undefined, values: {}});
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{text: string; error: boolean; progress?: boolean} | null>(null);
  const [now, setNow] = useState(Date.now());
  const forms = useRef<Record<string, Record<string, any>>>({}).current;
  // 1.2's media-grid: a floating bar over the bottom edge, and the "near the end" signal that
  // reveals a grid's next page
  const [overlay, setOverlay] = useState<React.ReactNode>(null);
  // 1.2's pick action: the media picker open over the screen, until the person chooses or cancels
  const [pickRequest, setPickRequest] = useState<PickRequest | null>(null);
  // 1.2's choose action (change 8): its sheet over the screen, until the person chooses or cancels
  const [chooseRequest, setChooseRequest] = useState<{offer: ChooseOffer; resolve: (answer: ChooseAnswer) => void} | null>(null);
  // the secure action's prompt (1.2), while it asks: the app's own screen for the capability
  const [grantRequest, setGrantRequest] = useState<{
    component: React.ComponentType<SecurePromptProps>;
    provider: CapabilityProvider;
    wanted: GrantRequest;
    resolve: (grant: string | null) => void;
  } | null>(null);
  // a protected document's secrets (1.2): the app's own prompt while it asks, and the dialog
  // that shows a revealed secret once - nothing else holds either
  const [secretAsk, setSecretAsk] = useState<{id: number; ask: SecretAsk; satellite: string; resolve: (value: string | null) => void} | null>(null);
  const [revealRequest, setRevealRequest] = useState<{value: string; satellite: string; resolve: () => void} | null>(null);
  const secretAsks = useRef(0);
  const nearEndListeners = useRef(new Set<() => void>()).current;
  const onNearEnd = useCallback(
    (listener: () => void) => {
      nearEndListeners.add(listener);
      return () => {
        nearEndListeners.delete(listener);
      };
    },
    [nearEndListeners],
  );
  const editing = useRef(false);
  const loadToken = useRef(0);
  // an offline page (UI contract 1.2): what is kept for it, for this server, session and
  // Satellite - shown only while StarCore can't be reached (src/satellites/ui/offline.ts)
  const serverId = activeServer?.id ?? 'default';
  const session = sessionScope(sessionToken);
  const store = useMemo(() => new OfflineStore(serverId, session, name), [serverId, session, name]);
  useEffect(() => {
    tidyOffline(serverId, session);
  }, [serverId, session]);
  const kept = useRef<{collection: string; entry: OfflineEntry; fromCache: boolean} | null>(null);
  const shownData = useRef<any>(null);
  const sourceTokens = useRef<Record<string, number>>({});
  const headerToken = useRef(0);

  // a protected document (1.2): one gate for its screens on this server, for this session
  // (src/vault/gate.ts), shown while one of them is focused with the app in the foreground
  const gated = Boolean(document?.protected);
  const vaultProvider = useMemo(
    () => (document?.protected ? protectedProvider(document, providers, name) : null),
    [document, providers, name],
  );
  const vaultApi = useMemo(() => (vaultProvider ? new VaultApi(client, vaultProvider) : null), [client, vaultProvider]);
  const [gateState, setGateState] = useState<GateState | null>(null);
  const gateRef = useRef<GateAttachment | null>(null);
  const gateKey = vaultApi ? `${serverId}|${session}|${name}` : null;
  const liveRef = useRef(live);
  liveRef.current = live;
  const gatedRef = useRef(gated);
  gatedRef.current = gated;
  useEffect(() => {
    if (!gateKey || !vaultApi) {
      setGateState(null);
      return;
    }
    const attached = attachGate(gateKey, () => createVaultGate({store: vaultApi}));
    gateRef.current = attached;
    setGateState(attached.gate.state());
    const unsubscribe = attached.gate.subscribe(setGateState);
    attached.setShown(liveRef.current);
    return () => {
      unsubscribe();
      if (gateRef.current === attached) {
        gateRef.current = null;
      }
      attached.detach(); // the last screen of the document gone: it locks
    };
  }, [gateKey, vaultApi]);
  useEffect(() => {
    gateRef.current?.setShown(live);
  }, [live]);
  const gateOpen = !gated || gateState === 'open';
  const inSetup = gated && gateState === 'setup';
  // "Forgot your PIN?" on the card: the document's forgot page, served without an unlock
  const inForgot = gated && gateState === 'forgot' && Boolean(document?.protected?.forgot);
  // its way back is the unlock card, the back gesture's too
  useEffect(() => {
    if (!inForgot || !focused) {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      gateRef.current?.gate.check();
      return true;
    });
    return () => subscription.remove();
  }, [inForgot, focused]);
  // a 401 or 403 from a protected document's own routes: locked again, most likely - its gate
  // asks the store, and the unlock card replaces what showed once it says so
  const recheck = useCallback((err: any) => {
    if (gatedRef.current && (err?.status === 401 || err?.status === 403)) {
      gateRef.current?.gate.check({quiet: true});
    }
  }, []);
  // a protected document can't be captured: no screenshot, recording or recent-apps preview
  useEffect(() => {
    if (!gated) {
      return;
    }
    privacy.setSecure(true);
    return () => privacy.setSecure(false);
  }, [gated]);

  const navigationItems = useMemo(
    () => (document?.navigation ?? []).filter(item => !item.developer || developer),
    [document, developer],
  );
  const hidden = (target: string | undefined) =>
    Boolean(target && (document?.navigation ?? []).some(item => item.page === target && item.developer && !developer));
  // a protected document that isn't set up shows its setup page, whatever was asked for, and
  // no page at all while it is locked
  const pageId = inSetup
    ? document?.protected?.setup
    : inForgot
      ? document?.protected?.forgot
      : document && requestedPage && document.pages[requestedPage] && !hidden(requestedPage) ? requestedPage : document?.entry;
  const page = document && pageId && (gateOpen || inSetup || inForgot) ? document.pages[pageId] : null;
  const topLevel = !!document && (pageId === document.entry || navigationItems.some(item => item.page === pageId));
  const paramsKey = JSON.stringify(params);
  const pageState = useMemo(
    () => ({...(page?.state ?? {}), ...(choices.page === pageId ? choices.values : {})}),
    [page, pageId, choices],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loaded, found] = await Promise.all([api.document(name, revision), api.providers()]);
        if (cancelled) {
          return;
        }
        const missing = missingRequirements(loaded.document.requires, found);
        if (missing.length) {
          setFatal(missing.map(item => (item.kind === 'client'
            ? `This interface needs ${item.name}, which this app doesn't offer yet. Update StarCore for Android to use it.`
            : `This interface needs a Satellite that provides ${item.name}.`)).join('\n'));
          return;
        }
        if (loaded.document.protected && !protectedProvider(loaded.document, found, name)) {
          setFatal(`This interface is kept locked by ${loaded.document.protected.capability}, which ${name} doesn't offer on this server.`);
          return;
        }
        setDocument(loaded.document);
        setOffline(loaded.offline);
        setProviders(found);
        if (/"section"\s*:/.test(JSON.stringify(loaded.document))) {
          new SatellitesApi(client)
            .list()
            .then(list => !cancelled && setSatellites(list))
            .catch(() => undefined); // its controls stay hidden
        }
      } catch (err: any) {
        if (!cancelled) {
          setFatal(err?.message || 'Could not load this interface.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, client, name, revision]);

  // a new page starts afresh
  useEffect(() => {
    kept.current = null;
    shownData.current = null;
    setSources({});
    setData(null);
    setDataError(null);
    setUpdatedAt(null);
  }, [page, paramsKey]);

  // a protected document not open (locked, or in setup): nothing its store showed stays in
  // memory - answers still on their way are dropped, and what was typed or chosen goes too
  useEffect(() => {
    if (!gated || gateOpen) {
      return;
    }
    loadToken.current += 1;
    headerToken.current += 1;
    for (const key of Object.keys(sourceTokens.current)) {
      sourceTokens.current[key] += 1;
    }
    kept.current = null;
    shownData.current = null;
    setData(null);
    setSources({});
    setHeader(null);
    setLoading(false);
    setChoices({page: undefined, values: {}});
    for (const key of Object.keys(forms)) {
      delete forms[key];
    }
  }, [gated, gateOpen, forms]);

  // a progress toast ("Uploading 2 of 5") stays until what follows replaces it
  const showToast = useCallback((text: string | null, error = false, progress = false) => {
    setToast(text ? {text, error, progress} : null);
  }, []);

  useEffect(() => {
    if (!toast || toast.progress) {
      return;
    }
    const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  // keeps "updated 12s ago" and the offline notice honest between refreshes
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [live]);

  const stateKey = JSON.stringify(pageState);
  const bindings = useMemo(() => ({params, state: pageState}), [paramsKey, stateKey]);

  // the state a kept page's source depends on: only a choice's (one collection per value), never
  // a search's free text - such a page isn't kept at all
  const keptStateKeys = useMemo(() => (page ? offlineStateKeys(page) : null), [page]);
  const offlinePage = Boolean(
    !gated &&
    (page?.offline === true || (page?.offline && typeof page.offline === 'object')) &&
      page.source &&
      keptStateKeys !== null,
  );
  // what this page may keep: only the fields its blocks bind, never one it omits
  const plan = useMemo(() => offlinePlan(page), [page]);
  const keptState = Object.fromEntries((keptStateKeys ?? []).map(key => [key, (pageState as any)?.[key]]));
  const collection = pageId ? collectionKey(pageId, params, keptState) : '';

  const loadData = useCallback(async () => {
    if (!page) {
      return;
    }
    const token = ++loadToken.current;
    if (!page.source) {
      setData({});
      return;
    }
    setLoading(true);
    try {
      const body = await api.read(name, resolveTemplate(page.source.route, bindings));
      if (token === loadToken.current) {
        const fresh = body && typeof body === 'object' ? body : {};
        if (offlinePage) {
          // a live answer replaces what was kept; its grids add their pages as they load them
          const entry: OfflineEntry = {savedAt: Date.now(), data: fresh, grids: {}};
          kept.current = {collection, entry, fromCache: false};
          store.write(collection, entry, plan);
        }
        shownData.current = fresh;
        setData(fresh);
        setDataError(null);
        setUpdatedAt(Date.now());
      }
    } catch (err: any) {
      if (token !== loadToken.current) {
        return;
      }
      const status = typeof err?.status === 'number' ? err.status : 0;
      if (status === 401 || (status === 403 && !gated)) {
        // the server no longer lets this session in: nothing it kept may be shown any more
        kept.current = null;
        await forgetOfflineServer(serverId);
      }
      recheck(err);
      if (status === 0 && offlinePage && (shownData.current === null || kept.current?.fromCache)) {
        // StarCore can't be reached: what was kept for this page, marked with its age
        const entry = await store.read(collection);
        if (entry && token === loadToken.current) {
          kept.current = {collection, entry, fromCache: true};
          shownData.current = entry.data;
          setData(entry.data);
          setUpdatedAt(entry.savedAt);
        }
      }
      if (token === loadToken.current) {
        setDataError(err?.message || 'Could not load this page.');
        setUnreachable(status === 0);
      }
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
      }
    }
  }, [api, name, page, bindings, offlinePage, collection, store, serverId, plan, gated, recheck]);

  // a grid on an offline page: its pages are kept with the page data (never with kept data
  // shown, which must not be written back as if it were live), and given back with it
  const offlineGrids = useMemo(
    () => ({
      restore: (grid: string): GridPages | null => {
        const current = kept.current;
        return current?.fromCache && current.collection === collection ? current.entry.grids[grid] ?? null : null;
      },
      save: (grid: string, pages: GridPages) => {
        const current = kept.current;
        if (!offlinePage || !current || current.fromCache || current.collection !== collection) {
          return;
        }
        current.entry.grids = {...current.entry.grids, [grid]: pages};
        store.write(collection, current.entry, plan);
      },
    }),
    [offlinePage, collection, store, plan],
  );

  const loadSource = useCallback(
    async (sourceName: string) => {
      const source = page?.sources?.[sourceName];
      if (!source) {
        return;
      }
      const token = (sourceTokens.current[sourceName] ?? 0) + 1;
      sourceTokens.current[sourceName] = token;
      try {
        const body = await api.read(name, resolveTemplate(source.route, bindings));
        if (sourceTokens.current[sourceName] === token) {
          setSources(current => ({...current, [sourceName]: body}));
        }
      } catch (err: any) {
        // a named source is supplementary: its blocks show what they have, the page stays
        recheck(err);
      }
    },
    [api, name, page, bindings, recheck],
  );

  const loadHeader = useCallback(async () => {
    const source = document?.header?.source;
    if (!source || !gateOpen) {
      return;
    }
    const token = ++headerToken.current;
    try {
      const body = await api.read(name, resolveTemplate(source.route, {}));
      if (token === headerToken.current) {
        setHeader(body && typeof body === 'object' ? body : {});
      }
    } catch (err: any) {
      // the page's own notice says when StarCore isn't answering
      recheck(err);
    }
  }, [api, name, document, gateOpen, recheck]);

  const loadAll = useCallback(() => {
    loadData();
    for (const sourceName of Object.keys(page?.sources ?? {})) {
      loadSource(sourceName);
    }
  }, [loadData, loadSource, page]);

  // 1.2 (change 9): a page that `follows` a capability reloads when this app changes it
  // elsewhere (a like in the player)
  const followed = Array.isArray(page?.follows) ? page!.follows : null;
  const onAudioChanged = audio?.onChanged;
  useEffect(() => {
    if (!onAudioChanged || !followed?.length || !live) {
      return;
    }
    return onAudioChanged(capability => {
      if (followed.includes(capability)) {
        loadAll();
      }
    });
  }, [onAudioChanged, followed, live, loadAll]);

  // on open, on a new page or choice, and again on coming back - to this
  // screen (a detail page may have changed what it shows) or to the app
  useEffect(() => {
    if (live) {
      loadAll();
    }
  }, [live, loadAll]);
  useEffect(() => {
    if (live && topLevel) {
      loadHeader();
    }
  }, [live, topLevel, loadHeader]);

  // StarCore can't be reached: try again now and then while the screen shows, so the page
  // turns live again on its own once it can (coming back to the app tries at once)
  useEffect(() => {
    if (!live || !dataError || !unreachable) {
      return;
    }
    const timer = setInterval(() => loadData(), 15000);
    return () => clearInterval(timer);
  }, [live, dataError, unreachable, loadData]);

  // live pages refresh on their own while visible - never under a finger
  const busy = useCallback(() => editing.current, []);
  usePolling(page?.source, live, loadData, busy);
  usePolling(document?.header?.source, live && topLevel, loadHeader, busy);
  useEffect(() => {
    if (!live) {
      return;
    }
    const timers = Object.entries(page?.sources ?? {})
      .filter(([, source]) => source?.refresh)
      .map(([sourceName, source]) =>
        setInterval(() => {
          if (!editing.current) {
            loadSource(sourceName);
          }
        }, Math.max(2, source.refresh as number) * 1000),
      );
    return () => timers.forEach(timer => clearInterval(timer));
  }, [live, page, loadSource]);

  useEffect(() => {
    const title = page?.title !== undefined && !topLevel ? resolve(page.title, {data: data ?? {}, params}) : null;
    navigation.setOptions({title: title ? String(title) : document?.title || name});
    // params only matter through the page data they selected
  }, [navigation, page, data, document, name, topLevel]);

  const go = useCallback(
    (target: string, targetParams: Record<string, any> = {}) => {
      if (!document?.pages[target]) {
        return;
      }
      const isTop = target === document.entry || (document.navigation ?? []).some(item => item.page === target);
      if (isTop && topLevel) {
        navigation.setParams({page: target, params: {}});
      } else if (isTop) {
        navigation.navigate({name: 'SatelliteUi', params: {name, page: target, revision}, merge: false} as any);
      } else {
        navigation.push('SatelliteUi', {name, page: target, params: targetParams, revision});
      }
    },
    [document, navigation, name, revision, topLevel],
  );

  // images (1.2) load from this Satellite's own routes, with the signed-in session
  const baseUrl = activeServer?.baseUrl ?? '';
  const mediaSource = useCallback(
    (mediaRoute: string) => ({
      uri: `${baseUrl}/api/satellites/${encodeURIComponent(name)}/${mediaRoute}`,
      headers: sessionToken ? {Authorization: `Bearer ${sessionToken}`} : undefined,
    }),
    [baseUrl, name, sessionToken],
  );

  /** What follows a request that succeeded: the Satellite's kept copies forgotten, the answer's
   * message, then the action's `then`. */
  const finishAction = useCallback(
    async (action: UiAction, scope: Scope, scoped: Scope, result: any, options?: {quiet?: boolean; update?: () => void}) => {
      const quiet = Boolean(options?.quiet);
      // something changed on the server: what was kept for this Satellite may no longer be true
      // (an item gone, moved, renamed) - forgotten before the page reloads and keeps afresh
      kept.current = null;
      await store.forgetSatellite();
      if (gatedRef.current && gateRef.current) {
        // the store may have changed state: set up now (locked, the unlock card follows), a new
        // PIN (every unlock ended), delinked (back to setup); still open stays as it is
        gateRef.current.gate.check({quiet: true});
      }
      if (typeof action.reloads === 'string') {
        // 1.2 (change 9): what the app keeps of that capability (the player's likes) read again
        void audio?.reload(action.reloads);
      }
      if (!quiet) {
        showToast(typeof result?.message === 'string' ? result.message : null);
      }
      const then = action.then;
      if (then === 'back') {
        navigation.goBack();
      } else if (then && typeof then === 'object' && then.navigate) {
        go(then.navigate, resolve(then.params ?? {}, {...scoped, data: result ?? {}}));
      } else if (then === 'refresh') {
        loadData();
      } else if (then === 'update' && mergeItem(scope.data, result)) {
        // 1.2: the answer's item merged into its own row, which redraws in place - the list keeps
        // its pages and its scroll position
        if (options?.update) {
          options.update();
        } else {
          setData((current: any) => (current && typeof current === 'object' ? {...current} : current));
        }
      }
      return true;
    },
    [audio, go, loadData, navigation, showToast, store],
  );

  const runAction = useCallback(
    async (
      action: UiAction | undefined,
      scope: Scope,
      value?: unknown,
      options?: {quiet?: boolean; update?: () => void},
    ): Promise<boolean> => {
      const quiet = Boolean(options?.quiet);
      if (!action) {
        return false;
      }
      const scoped: Scope = {...scope, value};
      if (action.navigate) {
        go(action.navigate, resolve(action.params ?? {}, scoped));
        return true;
      }
      if (action.secure) {
        // 1.2: one protected operation on this item, behind the app's own prompt
        return runSecureRef.current(action, [scope]);
      }
      if (action.section !== undefined) {
        // 1.2: a Satellite this one hosts (section_of), pushed over this screen in its shared
        // interface, so Back returns here
        const target = hostedSatellite(satellites, name, resolve(action.section, scoped));
        if (target && opensSharedInterface(target)) {
          navigation.push('SatelliteUi', {name: target.name, revision: target.ui?.revision ?? undefined});
          return true;
        }
        showToast("That isn't available in this app.", true);
        return false;
      }
      if (action.own !== undefined) {
        // 1.2: the Satellite's own interface - this app has none for any Satellite, so the
        // blocks hide such an action (hasOwnScreens) and one that still arrives does nothing
        showToast("That isn't available in this app.", true);
        return false;
      }
      if (action.sync !== undefined) {
        // 1.2: the app's own sync screen for this Satellite's provider - pushed over this one;
        // the document supplies nothing of it
        const target = syncTarget(action, providers, name);
        if (!target) {
          showToast("That isn't available in this app.", true);
          return false;
        }
        (navigation as any).push(SYNC_SCREENS[target.capability], {satellite: target.provider.satellite, capability: target.capability});
        return true;
      }
      if (action.download !== undefined || action.share !== undefined) {
        // 1.2: a file from the Satellite's own route, fetched with this session by the app's own
        // module: saved to Downloads, opened in the phone's own viewer (`open`), or handed to the
        // system share sheet
        const sharing = action.share !== undefined;
        const opening = !sharing && action.open === true;
        const route = resolveTemplate(String(sharing ? action.share : action.download), scoped);
        if (!route || !isSafeRoute(route)) {
          showToast("That file isn't available.", true);
          return false;
        }
        const fileTitle = fileName(action.name !== undefined ? resolve(action.name, scoped) : null, route);
        try {
          if (sharing) {
            await shareFile(mediaSource(route), fileTitle);
          } else if (opening) {
            await openFile(mediaSource(route), fileTitle);
          } else {
            showToast(`Saved to Downloads: ${await saveFile(mediaSource(route), fileTitle)}`);
          }
          return true;
        } catch (err: any) {
          showToast(err?.message || (sharing ? 'Could not share that.' : opening ? 'Could not open that.' : 'Could not save that.'), true);
          return false;
        }
      }
      if (action.upload !== undefined) {
        // 1.2: files chosen with the system document picker, each streamed by the app's own
        // module as the raw body of a POST to the Satellite's route, a conflict asked about file
        // by file, then one report of every file
        let picked;
        try {
          picked = await pickFiles(action.upload?.multiple === true);
        } catch (err: any) {
          showToast(err?.message || 'Could not choose files.', true);
          return false;
        }
        if (!picked.length) {
          return false; // the picker was closed: nothing runs
        }
        const result = await runUploads(picked, action, {
          url: (template, fileValue) => {
            const route = resolveTemplate(template, {...scoped, value: fileValue});
            return isSafeRoute(route) ? mediaSource(route).uri : null;
          },
          send: (url, file) => uploadFile(file, {uri: url, headers: mediaSource('').headers}),
          confirm: (fileValue, message) => {
            const asked = message === undefined ? '' : String(resolve(message as any, {...scoped, value: fileValue}) ?? '');
            return confirmAction(fileValue.name, 'Replace', asked || 'It is already there. Replace it?');
          },
          progress: (index, total, fileValue) =>
            showToast(total > 1 ? `Uploading ${index + 1} of ${total}: ${fileValue.name}…` : `Uploading ${fileValue.name}…`, false, true),
        });
        const report = uploadReport(result);
        showToast(report.text, report.error);
        if (result.uploaded.length) {
          // what was kept for this Satellite no longer shows what is there
          kept.current = null;
          await store.forgetSatellite();
          if (action.then === 'back') {
            navigation.goBack();
          } else {
            loadData();
          }
        } else if (result.failed.length) {
          loadData(); // show what's actually true now
        }
        return result.uploaded.length > 0;
      }
      if (action.offline !== undefined) {
        // 1.2 (change 10): kept on this phone by the audio host's downloads, only when this
        // Satellite is the audio.library provider; the document names tracks and nothing else
        const keeper = audio?.offlineFor(name);
        if (!keeper || !action.offline || typeof action.offline !== 'object') {
          showToast("That isn't available in this app.", true);
          return false;
        }
        return runOffline(action.offline as any, scoped, {
          load: offlineRoute => api.read(name, offlineRoute),
          keeper,
          confirm: (title, button, message) => confirmAction(title, button, message),
          notify: (message, error) => showToast(message, error),
        });
      }
      if (action.play) {
        // 1.2: played by the app's audio host, from whichever Satellite provides audio.library
        try {
          if (!audio) {
            throw new Error('Audio playback is not available here.');
          }
          const play = action.play;
          if (play.search !== undefined) {
            const found = await audio.playSearch(String(resolve(play.search, scoped) ?? ''));
            showToast(found ? null : 'Nothing to play was found.', !found);
            return found > 0;
          }
          // the Satellite's own tracks: listed in the page, or what one of its routes answers
          let tracks: unknown;
          let page: PagedPlay | null = null;
          // a route's answer may name what it plays from (a radio station's context)
          let context: unknown = play.context === undefined ? undefined : resolve(play.context, scoped);
          if (play.route) {
            const route = resolveTemplate(play.route, scoped);
            if (!isSafeRoute(route)) {
              throw new Error('That cannot be played.');
            }
            const answer = await api.read(name, route);
            tracks = answer?.tracks;
            if (play.context === undefined && typeof answer?.context === 'string') {
              context = answer.context;
            }
            // a long list answers page by page: the host asks the same route for more (cursor=,
            // or positions= to shuffle) as the queue runs low
            const joiner = route.includes('?') ? '&' : '?';
            page = {
              answer,
              load: params =>
                api.read(
                  name,
                  `${route}${joiner}${Object.entries(params)
                    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
                    .join('&')}`,
                ),
            };
          } else {
            tracks = resolve(play.tracks, scoped);
          }
          const taken = await audio.playTracks(name, tracks, {
            start: play.start === undefined ? undefined : resolve(play.start, scoped),
            shuffle: play.shuffle === true,
            queue: play.queue,
            context,
            page,
          });
          showToast(taken ? null : 'There is nothing to play here.', !taken);
          return taken > 0;
        } catch (err: any) {
          showToast(err?.message || 'Could not play that.', true);
          return false;
        }
      }
      if (action.pick) {
        // 1.2: the person chooses through the media picker, from whichever Satellite the catalog
        // says provides the capability; the route then gets the references as $value
        const pick = action.pick;
        const provider = findProvider(providers, pick.capability);
        if (!provider) {
          showToast(`No enabled Satellite provides ${pick.capability}, so there is nothing to choose from.`, true);
          return false;
        }
        const picked = await new Promise<MediaReference[] | null>(done =>
          setPickRequest({
            provider,
            capability: pick.capability,
            kinds: Array.isArray(pick.kinds) ? pick.kinds : undefined,
            multiple: pick.multiple === true,
            title: pick.title !== undefined ? String(resolve(pick.title, scoped) ?? '') : '',
            resolve: value => {
              setPickRequest(null);
              done(value);
            },
          }),
        );
        if (!picked) {
          return false; // cancelled: nothing runs
        }
        scoped.value = picked;
      }
      const finish = (result: any) => finishAction(action, scope, scoped, result, options);
      if (action.choose) {
        // 1.2 (change 8): one row of what the Satellite's source answers, or a new one, in the
        // app's own sheet; the route then gets it as $value, a 409 asked about before sending again
        let chosen: {result: any} | null;
        try {
          chosen = await runChoose(action, scoped, {
            load: route => api.read(name, route),
            choose: offer =>
              new Promise<ChooseAnswer>(done =>
                setChooseRequest({
                  offer,
                  resolve: answer => {
                    setChooseRequest(null);
                    done(answer);
                  },
                }),
              ),
            request: (route, body) => api.act(name, route, 'POST', body),
            confirm: text => confirmAction(text),
          });
        } catch (err: any) {
          recheck(err);
          if (!quiet) {
            showToast(err?.message || 'That action failed.', true);
          }
          return false;
        }
        if (!chosen) {
          return false; // cancelled or declined: nothing more is sent
        }
        return finish(chosen.result);
      }
      if (action.confirm && !(await confirmAction(String(resolve(action.confirm, scoped))))) {
        return false;
      }
      const method = action.method ?? 'POST';
      const who = document?.title || name;
      let body: any = action.body !== undefined ? resolve(action.body, scoped) : scope.form ?? {};
      if (action.secrets !== undefined) {
        // 1.2: asked in the app's own prompt, only for a protected document, and put in this
        // one request's body - never in the form, the page's state or a toast
        if (!gatedRef.current || method === 'GET') {
          showToast('That action asks for a secret this interface may not ask for.', true);
          return false;
        }
        const secrets = await askSecrets(action.secrets, ask =>
          new Promise<string | null>(done => {
            secretAsks.current += 1;
            setSecretAsk({
              id: secretAsks.current,
              ask,
              satellite: who,
              resolve: answer => {
                setSecretAsk(null);
                done(answer);
              },
            });
          }),
        );
        if (!secrets) {
          return false; // cancelled: nothing is sent
        }
        body = bodyWithSecrets(body, secrets);
      }
      let result: any;
      try {
        result = await api.act(name, resolveTemplate(action.route ?? '', scoped), method, body);
      } catch (err: any) {
        recheck(err);
        if (!quiet) {
          showToast(err?.message || 'That action failed.', true);
          loadData(); // show what's actually true now
        }
        return false;
      } finally {
        body = null;
      }
      if (action.reveal !== undefined && gatedRef.current) {
        // 1.2: shown once in the app's own dialog, then gone from the answer before a toast or
        // `then` sees it
        result = await revealFrom(result, action.reveal, secret =>
          new Promise<void>(done =>
            setRevealRequest({
              value: secret,
              satellite: who,
              resolve: () => {
                setRevealRequest(null);
                done();
              },
            }),
          ),
        );
      }
      return finish(result);
    },
    [api, name, go, loadData, navigation, showToast, audio, providers, store, mediaSource, satellites, recheck, document, finishAction],
  );

  /** The secure action (1.2) on these items: one request, and one prompt when the session
   * hasn't unlocked the provider - for a single-use grant, never an unlock. What moved is
   * forgotten from every session's offline copies and from the image cache. */
  const runSecureAction = useCallback(
    async (action: UiAction, items: Scope[], imagesOf?: (item: Scope) => string[]): Promise<boolean> => {
      const runner = secureRunner(action, providers, name, SECURE_PROMPTS);
      if (!runner || !items.length) {
        showToast("That isn't available on this server.", true);
        return false;
      }
      if (action.confirm && !(await confirmAction(String(resolve(action.confirm, {...items[0], value: items.length}))))) {
        return false;
      }
      const {provider, prompt} = runner;
      const ids = items.map(item => resolve(action.item, item));
      const result = await runSecure({
        action, ids, satellite: name, provider,
        read: route => api.read(provider.satellite, route),
        post: (route, body) => api.act(provider.satellite, route, 'POST', body),
        grant: wanted =>
          new Promise<string | null>(done =>
            setGrantRequest({
              component: prompt.component,
              provider,
              wanted,
              resolve: grant => {
                setGrantRequest(null);
                done(grant);
              },
            }),
          ),
      });
      if (result.outcome === 'cancelled') {
        return false;
      }
      if (result.moved.length) {
        // gone from here for good: never shown offline again, by any session, nor from the cache
        kept.current = null;
        await forgetOfflineSatellite(serverId, name);
        const movedIds = new Set(result.moved.map(item => String(item?.id)));
        privacy.evictImages(
          items.filter((item, at) => movedIds.has(String(ids[at]))).flatMap(item => imagesOf?.(item) ?? []),
        );
      }
      showToast(result.text, result.outcome !== 'done');
      if (result.moved.length) {
        if (action.then === 'back') {
          navigation.goBack();
        } else {
          loadData();
        }
      }
      return result.moved.length > 0;
    },
    [providers, name, api, serverId, showToast, navigation, loadData],
  );
  const runSecureRef = useRef(runSecureAction);
  runSecureRef.current = runSecureAction;
  // whether an action's control is drawn here: a secure action only where it can run, a section
  // only where this app opens it (a binding is checked when pressed), a sync only where this app
  // has that sync screen for this Satellite's own provider, and download, open, share or
  // upload only where this phone can (saving needs Android 10 or later). A protected document
  // shares nothing, and opens nothing in another app: that would leave a copy in the app's cache.
  const canRun = useCallback(
    (action: UiAction | undefined) =>
      (action?.download === undefined || (action.open === true ? !gated && canOpenFiles() : canSaveFiles())) &&
      (action?.share === undefined || (!gated && canShareFiles())) &&
      (action?.upload === undefined || canUploadFiles()) &&
      (action?.section === undefined ||
        (typeof action.section === 'string' && action.section.startsWith('$')) ||
        opensHosted(hostedSatellite(satellites, name, action.section))) &&
      (!action?.secure || Boolean(secureRunner(action, providers, name, SECURE_PROMPTS))) &&
      (action?.sync === undefined || Boolean(syncTarget(action, providers, name))) &&
      (action?.offline === undefined || Boolean(audio?.offlineFor(name))),
    [providers, name, gated, satellites, audio],
  );

  // the picker reads the provider's routes, and loads its thumbnails, with this session
  const readProvider = useCallback((satellite: string, providerRoute: string) => api.read(satellite, providerRoute), [api]);
  // a grid's next page, a map's viewport: this Satellite's own routes, with this session
  const loadOwn = useCallback(
    (ownRoute: string) =>
      api.read(name, ownRoute).catch(err => {
        recheck(err);
        throw err;
      }),
    [api, name, recheck],
  );
  const providerSource = useCallback(
    (satellite: string, providerRoute: string) => ({
      uri: `${baseUrl}/api/satellites/${encodeURIComponent(satellite)}/${providerRoute}`,
      headers: sessionToken ? {Authorization: `Bearer ${sessionToken}`} : undefined,
    }),
    [baseUrl, sessionToken],
  );
  const afterSelection = useCallback(
    (then: UiAction['then'], failed: number, total: number) => {
      if (failed) {
        showToast(`${failed} of ${total} could not be done.`, true);
      }
      if (then === 'back') {
        navigation.goBack();
      } else if (then === 'refresh') {
        loadData();
      }
    },
    [showToast, navigation, loadData],
  );

  const context: BlockContext = {
    developer,
    providers,
    runAction,
    readCapability: (satellite, capabilityRoute) => api.read(satellite, capabilityRoute),
    mediaSource,
    load: loadOwn,
    onNearEnd,
    setOverlay,
    confirm: confirmAction,
    afterSelection,
    satellite: name,
    hasOwnScreens: false,
    canRun,
    runSecure: runSecureAction,
    preferences,
    offlineGrids,
    forms,
    setEditing: value => {
      editing.current = value;
    },
    pageState,
    setPageState: (key, value) =>
      setChoices(current => {
        const values = current.page === pageId ? current.values : {};
        return values[key] === value ? current : {page: pageId, values: {...values, [key]: value}};
      }),
    refreshing: loading && data !== null,
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadData(), loadHeader(), ...Object.keys(page?.sources ?? {}).map(loadSource)]);
    setRefreshing(false);
  };

  if (fatal) {
    return (
      <View style={styles.center}>
        <Icon name="alert-triangle" size={28} color={palette.text3} />
        <Text style={styles.fatal}>{fatal}</Text>
      </View>
    );
  }
  if (document && gated && !gateOpen && !inSetup && !inForgot) {
    const title = document.title || name;
    return (
      <ScrollView contentContainerStyle={styles.gate} keyboardShouldPersistTaps="handled" testID="ui-gate">
        {gateState === 'failed' ? (
          <View style={styles.failure} testID="ui-gate-failed">
            <Text style={type.title}>{`${title} is unavailable`}</Text>
            <Text style={type.body}>{gateRef.current?.gate.detail() || 'StarCore did not answer.'}</Text>
            <Pressable
              onPress={() => gateRef.current?.gate.check()}
              accessibilityRole="button"
              testID="ui-gate-retry"
              style={({pressed}) => [styles.retry, pressed && styles.pressed]}>
              <Text style={type.label}>Try again</Text>
            </Pressable>
          </View>
        ) : gateState === 'locked' && focused && vaultProvider ? (
          <LockedDocument
            provider={vaultProvider}
            title={title}
            onUnlocked={() => gateRef.current?.gate.opened()}
            onForgot={document.protected?.forgot ? () => gateRef.current?.gate.forgot() : undefined}
          />
        ) : (
          <ActivityIndicator color={accent} />
        )}
      </ScrollView>
    );
  }
  if (!document || !page) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={accent} />
      </View>
    );
  }

  const scope: Scope = {data: data ?? {}, page: data ?? {}, params, state: pageState, sources};
  const tabs = topLevel ? navigationItems : [];
  const headerBlocks = topLevel && document.header && header ? document.header.blocks : null;
  const stale = Boolean(data !== null && dataError);
  const ago = updatedAt ? formatValue(Math.round(updatedAt / 1000), 'relative', undefined, {now: now / 1000}) : null;
  const template = page.template ?? 'stack';
  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={accent}
      colors={[accent]}
      progressBackgroundColor={palette.card}
    />
  );
  // 1.2: a page whose main content is a media-grid is drawn as that grid's virtualized list,
  // so only the rows near the screen are mounted however large the collection
  const blocks = page.blocks ?? [];
  const gridIndex =
    template === 'stack' && data !== null
      ? blocks.findIndex(
          block =>
            block?.type === 'media-grid' &&
            block.layout !== 'row' &&
            !(block.developer && !developer) &&
            (!('visible' in block) || isVisible(resolve(block.visible, scope))),
        )
      : -1;
  // 1.2: so is a page with a list that loads further pages among its own blocks - its blocks
  // and its lists' rows as one virtualized list
  const listPage = template === 'stack' && data !== null && gridIndex < 0 && hasPagedList(blocks, scope, context);
  // the screen nears its end: a grid or a paged list drawn in place reveals or loads more
  const nearEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {layoutMeasurement, contentOffset, contentSize} = event.nativeEvent;
    if (nearEndListeners.size && layoutMeasurement.height + contentOffset.y >= contentSize.height - 900) {
      nearEndListeners.forEach(listener => listener());
    }
  };
  const hasTop = Boolean(headerBlocks) || tabs.length > 1 || offline || stale;
  const top = (
    <>
      {inForgot && (
        <Pressable
          onPress={() => gateRef.current?.gate.check()}
          accessibilityRole="button"
          hitSlop={8}
          testID="ui-forgot-back"
          style={({pressed}) => [styles.forgotBack, pressed && styles.pressed]}>
          <Icon name="chevron-left" size={18} color={palette.text2} />
          <Text style={[type.label, {color: palette.text2}]}>Back to unlock</Text>
        </Pressable>
      )}
      {headerBlocks && (
          <View style={styles.header} testID="ui-header">
            <UiBlocks blocks={headerBlocks} scope={{data: header, page: header, params: {}}} context={{...context, inline: true}} />
          </View>
        )}
        {tabs.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
            {tabs.map(item => {
              const active = item.page === pageId;
              return (
                <Pressable
                  key={item.page}
                  accessibilityRole="tab"
                  accessibilityState={{selected: active}}
                  onPress={() => go(item.page)}
                  testID={`ui-tab-${item.page}`}
                  style={[styles.tab, active && {backgroundColor: accent}]}>
                  {isIconName(item.icon, document.icons ?? null) && (
                    <Glyph name={item.icon} size={15} color={active ? onColor : palette.text2} />
                  )}
                  <Text style={[styles.tabLabel, active && {color: onColor}]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        {offline && <Text style={styles.offlineLayout}>Showing the last saved layout - StarCore is unreachable.</Text>}
        {stale && (
          <View style={styles.offline} accessibilityRole="alert" testID="ui-stale">
            <Text style={[type.label, styles.offlineTitle]}>{unreachable ? 'Offline' : 'Not refreshed'}</Text>
            <Text style={type.caption}>{`Showing what StarCore said${ago ? ` ${ago}` : ' earlier'}. ${dataError}`}</Text>
          </View>
        )}
    </>
  );
  return (
    <MemoryImages.Provider value={gated}>
    <GlyphIcons icons={document.icons ?? null}>
    <View style={styles.screen}>
      {gridIndex >= 0 ? (
        <VirtualMediaGrid
          key={`${pageId}:${paramsKey}`}
          block={blocks[gridIndex]}
          scope={scope}
          context={context}
          refreshControl={refreshControl}
          contentContainerStyle={styles.content}
          header={
            <View style={[styles.virtualTop, stale && styles.stalePage]}>
              {top}
              <UiPageBlocks blocks={blocks.slice(0, gridIndex)} scope={scope} context={context} template={template} />
            </View>
          }
          footer={
            <View style={styles.page}>
              <UiPageBlocks blocks={blocks.slice(gridIndex + 1)} scope={scope} context={context} template={template} />
              <FloatingPlayerSpacer />
            </View>
          }
        />
      ) : listPage ? (
        <VirtualListPage
          key={`${pageId}:${paramsKey}`}
          blocks={blocks}
          scope={scope}
          context={context}
          refreshControl={refreshControl}
          contentContainerStyle={styles.listContent}
          onScroll={nearEnd}
          dim={stale}
          header={hasTop ? <View style={styles.listTop}>{top}</View> : null}
          footer={<FloatingPlayerSpacer />}
        />
      ) : (
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={nearEnd}
        refreshControl={refreshControl}>
        {top}
        {data === null && dataError ? (
          <View style={styles.failure} testID="ui-failure">
            <Text style={type.title}>{`${document.title || name} is unavailable`}</Text>
            <Text style={type.body}>{dataError}</Text>
            <Pressable
              onPress={loadAll}
              accessibilityRole="button"
              testID="ui-retry"
              style={({pressed}) => [styles.retry, pressed && styles.pressed]}>
              <Text style={type.label}>Try again</Text>
            </Pressable>
          </View>
        ) : data === null ? (
          <View style={styles.loading} testID="ui-loading">
            {[0, 1, 2].map(index => (
              <View key={index} style={styles.skeleton} />
            ))}
          </View>
        ) : (
          <View style={[styles.page, stale && styles.stalePage]}>
            <UiPageBlocks key={`${pageId}:${paramsKey}`} blocks={page.blocks} scope={scope} context={context} template={template} />
          </View>
        )}
        <FloatingPlayerSpacer />
      </ScrollView>
      )}
      {pickRequest && <MediaPicker request={pickRequest} read={readProvider} mediaSource={providerSource} />}
      {chooseRequest && <ChooseSheet offer={chooseRequest.offer} mediaSource={mediaSource} onDone={chooseRequest.resolve} />}
      {grantRequest && (
        <grantRequest.component
          count={grantRequest.wanted.items.length}
          provider={grantRequest.provider}
          wanted={grantRequest.wanted}
          onGrant={grant => grantRequest.resolve(grant)}
          onCancel={() => grantRequest.resolve(null)}
        />
      )}
      {secretAsk && (
        <SecretPrompt key={secretAsk.id} ask={secretAsk.ask} satellite={secretAsk.satellite} onDone={secretAsk.resolve} />
      )}
      {revealRequest && <RevealSecret value={revealRequest.value} satellite={revealRequest.satellite} onDone={revealRequest.resolve} />}
      {overlay && (
        <View style={[styles.overlay, {bottom: space.lg + playerInset}]} pointerEvents="box-none">
          {overlay}
        </View>
      )}
      {toast && (
        <View
          pointerEvents="none"
          style={[styles.toast, {bottom: space.xl + playerInset}, toast.error && styles.toastError]}
          accessibilityLiveRegion="polite">
          <Text style={[styles.toastText, toast.error && {color: palette.danger}]}>{toast.text}</Text>
        </View>
      )}
    </View>
    </GlyphIcons>
    </MemoryImages.Provider>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, backgroundColor: palette.bg, padding: space.xl},
  gate: {flexGrow: 1, justifyContent: 'center', padding: space.lg, backgroundColor: palette.bg},
  fatal: {...type.body, textAlign: 'center'},
  header: {gap: space.sm, paddingBottom: space.xs},
  tabs: {gap: space.sm, paddingBottom: space.xs},
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    backgroundColor: palette.control,
  },
  tabLabel: {...type.caption, color: palette.text2, fontWeight: '600'},
  offlineLayout: {...type.caption, color: palette.text3},
  offline: {
    padding: space.md,
    borderRadius: radii.control,
    backgroundColor: palette.control,
    borderLeftWidth: 3,
    borderLeftColor: palette.warn,
    gap: 2,
  },
  offlineTitle: {color: palette.warn},
  page: {gap: space.md},
  virtualTop: {gap: space.md},
  // a list page spaces its own lines (VirtualListPage), so its content has no gap
  listContent: {padding: space.lg, paddingBottom: space.xxl * 2},
  listTop: {gap: space.md, marginBottom: space.md},
  stalePage: {opacity: 0.6},
  loading: {gap: space.md},
  skeleton: {height: 120, borderRadius: radii.card, backgroundColor: palette.card},
  failure: {padding: space.xl, borderRadius: radii.card, backgroundColor: palette.card, gap: space.sm},
  retry: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderRadius: radii.control,
    backgroundColor: palette.controlStrong,
  },
  pressed: {opacity: 0.8},
  forgotBack: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: TOUCH_TARGET,
    paddingRight: space.md,
  },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: 12,
    backgroundColor: palette.controlStrong,
  },
  toastError: {backgroundColor: '#3a1c1f'},
  overlay: {position: 'absolute', left: space.lg, right: space.lg},
  toastText: {...type.caption, color: palette.text},
});
