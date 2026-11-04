import {useIsFocused} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {useAppActive} from '../hooks/useAppActive';
import {useServers} from '../servers/ServersContext';
import {UiApi} from '../satellites/ui/api';
import {
  ICONS, formatValue, missingRequirements, resolve, resolveTemplate,
  type Providers, type Scope, type UiAction, type UiDocument, type UiSource,
} from '../satellites/ui/contract';
import {BlockContext, confirmAction, UiBlocks, UiPageBlocks} from '../satellites/ui/UiBlocks';
import {TOUCH_TARGET, tokens, useAccent} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const {palette, radii, space, type} = tokens;

type Props = NativeStackScreenProps<SatellitesStackParamList, 'SatelliteUi'>;

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
 */
export function SatelliteUiScreen({route, navigation}: Props) {
  const {name, page: requestedPage, params = {}, revision} = route.params;
  const {client} = useAuth();
  const {activeServer} = useServers();
  const {enabled: developer} = useDeveloperMode();
  const {color: accent, onColor} = useAccent();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const live = focused && appActive;
  const api = useMemo(() => new UiApi(client, activeServer?.id ?? 'default'), [client, activeServer?.id]);

  const [document, setDocument] = useState<UiDocument | null>(null);
  const [offline, setOffline] = useState(false);
  const [providers, setProviders] = useState<Providers>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<Record<string, any>>({});
  const [header, setHeader] = useState<any>(null);
  // a choice's selections, for the page they were made on; the page's own defaults otherwise
  const [choices, setChoices] = useState<{page: string | undefined; values: Record<string, any>}>({page: undefined, values: {}});
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{text: string; error: boolean} | null>(null);
  const [now, setNow] = useState(Date.now());
  const forms = useRef<Record<string, Record<string, any>>>({}).current;
  const editing = useRef(false);
  const loadToken = useRef(0);
  const sourceTokens = useRef<Record<string, number>>({});

  const navigationItems = useMemo(
    () => (document?.navigation ?? []).filter(item => !item.developer || developer),
    [document, developer],
  );
  const hidden = (target: string | undefined) =>
    Boolean(target && (document?.navigation ?? []).some(item => item.page === target && item.developer && !developer));
  const pageId =
    document && requestedPage && document.pages[requestedPage] && !hidden(requestedPage) ? requestedPage : document?.entry;
  const page = document && pageId ? document.pages[pageId] : null;
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
        setDocument(loaded.document);
        setOffline(loaded.offline);
        setProviders(found);
      } catch (err: any) {
        if (!cancelled) {
          setFatal(err?.message || 'Could not load this interface.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, name, revision]);

  // a new page starts afresh
  useEffect(() => {
    setSources({});
    setData(null);
    setDataError(null);
    setUpdatedAt(null);
  }, [page, paramsKey]);

  const showToast = useCallback((text: string | null, error = false) => {
    setToast(text ? {text, error} : null);
  }, []);

  useEffect(() => {
    if (!toast) {
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
        setData(body && typeof body === 'object' ? body : {});
        setDataError(null);
        setUpdatedAt(Date.now());
      }
    } catch (err: any) {
      if (token === loadToken.current) {
        setDataError(err?.message || 'Could not load this page.');
      }
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
      }
    }
  }, [api, name, page, bindings]);

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
      } catch {
        // a named source is supplementary: its blocks show what they have, the page stays
      }
    },
    [api, name, page, bindings],
  );

  const loadHeader = useCallback(async () => {
    const source = document?.header?.source;
    if (!source) {
      return;
    }
    try {
      const body = await api.read(name, resolveTemplate(source.route, {}));
      setHeader(body && typeof body === 'object' ? body : {});
    } catch {
      // the page's own notice says when StarCore isn't answering
    }
  }, [api, name, document]);

  const loadAll = useCallback(() => {
    loadData();
    for (const sourceName of Object.keys(page?.sources ?? {})) {
      loadSource(sourceName);
    }
  }, [loadData, loadSource, page]);

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

  const runAction = useCallback(
    async (action: UiAction | undefined, scope: Scope, value?: unknown): Promise<boolean> => {
      if (!action) {
        return false;
      }
      const scoped: Scope = {...scope, value};
      if (action.navigate) {
        go(action.navigate, resolve(action.params ?? {}, scoped));
        return true;
      }
      if (action.confirm && !(await confirmAction(String(resolve(action.confirm, scoped))))) {
        return false;
      }
      let result: any;
      try {
        const body = action.body !== undefined ? resolve(action.body, scoped) : scope.form ?? {};
        result = await api.act(name, resolveTemplate(action.route ?? '', scoped), action.method ?? 'POST', body);
      } catch (err: any) {
        showToast(err?.message || 'That action failed.', true);
        loadData(); // show what's actually true now
        return false;
      }
      showToast(typeof result?.message === 'string' ? result.message : null);
      const then = action.then;
      if (then === 'back') {
        navigation.goBack();
      } else if (then && typeof then === 'object' && then.navigate) {
        go(then.navigate, resolve(then.params ?? {}, {...scoped, data: result ?? {}}));
      } else if (then === 'refresh') {
        loadData();
      }
      return true;
    },
    [api, name, go, loadData, navigation, showToast],
  );

  const context: BlockContext = {
    developer,
    providers,
    runAction,
    readCapability: (satellite, capabilityRoute) => api.read(satellite, capabilityRoute),
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
  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
            progressBackgroundColor={palette.card}
          />
        }>
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
                  {item.icon && ICONS.has(item.icon) && (
                    <Icon name={item.icon} size={15} color={active ? onColor : palette.text2} />
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
            <Text style={[type.label, styles.offlineTitle]}>Offline</Text>
            <Text style={type.caption}>{`Showing what StarCore said${ago ? ` ${ago}` : ' earlier'}. ${dataError}`}</Text>
          </View>
        )}
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
      {toast && (
        <View pointerEvents="none" style={[styles.toast, toast.error && styles.toastError]} accessibilityLiveRegion="polite">
          <Text style={[styles.toastText, toast.error && {color: palette.danger}]}>{toast.text}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, backgroundColor: palette.bg, padding: space.xl},
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
  toastText: {...type.caption, color: palette.text},
});
