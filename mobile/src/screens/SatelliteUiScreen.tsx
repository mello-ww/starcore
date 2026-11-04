import {useIsFocused} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {useServers} from '../servers/ServersContext';
import {UiApi} from '../satellites/ui/api';
import {
  ICONS, missingRequirements, resolve, resolveTemplate, type Providers, type Scope, type UiAction, type UiDocument,
} from '../satellites/ui/contract';
import {BlockContext, confirmAction, UiBlocks} from '../satellites/ui/UiBlocks';
import {tokens, useAccent} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';

const {palette, space, type} = tokens;

type Props = NativeStackScreenProps<SatellitesStackParamList, 'SatelliteUi'>;

/**
 * Any Satellite's declarative interface (its ui.json - see
 * docs/ui-contract.md), drawn with this app's own components. This screen
 * knows the contract, never a Satellite: a new one that ships a ui.json
 * works here with no change to the app.
 *
 * Top-level pages (the document's navigation) are tabs within one screen;
 * a detail page is pushed as another instance of this screen, so Android's
 * back gesture works as everywhere else.
 */
export function SatelliteUiScreen({route, navigation}: Props) {
  const {name, page: requestedPage, params = {}, revision} = route.params;
  const {client} = useAuth();
  const {activeServer} = useServers();
  const {enabled: developer} = useDeveloperMode();
  const {color: accent} = useAccent();
  const focused = useIsFocused();
  const api = useMemo(() => new UiApi(client, activeServer?.id ?? 'default'), [client, activeServer?.id]);

  const [document, setDocument] = useState<UiDocument | null>(null);
  const [offline, setOffline] = useState(false);
  const [providers, setProviders] = useState<Providers>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{text: string; error: boolean} | null>(null);
  const forms = useRef<Record<string, Record<string, any>>>({}).current;
  const editing = useRef(false);
  const loadToken = useRef(0);

  const pageId = document && requestedPage && document.pages[requestedPage] ? requestedPage : document?.entry;
  const page = document && pageId ? document.pages[pageId] : null;
  const topLevel = !!document && (pageId === document.entry || (document.navigation ?? []).some(item => item.page === pageId));

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

  const loadData = useCallback(async () => {
    if (!page) {
      return;
    }
    const token = ++loadToken.current;
    if (!page.source) {
      setData({});
      return;
    }
    try {
      const body = await api.read(name, resolveTemplate(page.source.route, {params}));
      if (token === loadToken.current) {
        setData(body && typeof body === 'object' ? body : {});
        setDataError(null);
      }
    } catch (err: any) {
      if (token === loadToken.current) {
        setDataError(err?.message || 'Could not load this page.');
      }
    }
    // params is a fresh object each render; its contents are what matter
  }, [api, name, page, JSON.stringify(params)]);

  // on open, and again on coming back to this page - something on the page
  // it opened (a detail page, say) may have changed what this one shows
  const wasFocused = useRef(focused);
  useEffect(() => {
    loadData();
  }, [loadData]);
  useEffect(() => {
    if (focused && !wasFocused.current) {
      loadData();
    }
    wasFocused.current = focused;
  }, [focused, loadData]);

  // live pages refresh on their own while visible - never under a finger
  useEffect(() => {
    const seconds = page?.source?.refresh;
    if (!focused || !seconds) {
      return;
    }
    const timer = setInterval(() => {
      if (!editing.current) {
        loadData();
      }
    }, Math.max(2, seconds) * 1000);
    return () => clearInterval(timer);
  }, [focused, page, loadData]);

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
      const bindings: Scope = {...scope, value};
      if (action.navigate) {
        go(action.navigate, resolve(action.params ?? {}, bindings));
        return true;
      }
      if (action.confirm && !(await confirmAction(String(resolve(action.confirm, bindings))))) {
        return false;
      }
      let result: any;
      try {
        const body = action.body !== undefined ? resolve(action.body, bindings) : scope.form ?? {};
        result = await api.act(name, resolveTemplate(action.route ?? '', bindings), action.method ?? 'POST', body);
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
        go(then.navigate, resolve(then.params ?? {}, {...bindings, data: result ?? {}}));
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
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
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

  const scope: Scope = {data: data ?? {}, page: data ?? {}, params};
  const tabs = topLevel ? document.navigation ?? [] : [];
  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} />}>
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
                  style={[styles.tab, active && {backgroundColor: accent}]}>
                  {item.icon && ICONS.has(item.icon) && (
                    <Icon name={item.icon} size={15} color={active ? palette.onAccent : palette.text2} />
                  )}
                  <Text style={[styles.tabLabel, active && {color: palette.onAccent}]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        {offline && <Text style={styles.offline}>Showing the last saved layout - StarCore is unreachable.</Text>}
        {dataError && <Text style={styles.error}>{dataError}</Text>}
        {data === null && !dataError ? (
          <ActivityIndicator color={accent} />
        ) : data !== null ? (
          <UiBlocks key={`${pageId}:${JSON.stringify(params)}`} blocks={page.blocks} scope={scope} context={context} />
        ) : null}
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
  offline: {...type.caption, color: palette.text3},
  error: {color: palette.danger, fontSize: 13},
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
