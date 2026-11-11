import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {SatellitesApi} from '../satellites/api';
import {getCachedSatellites, setCachedSatellites} from '../satellites/cache';
import {STATUS_LABELS, satelliteIcon, statusDotColor} from '../satellites/icons';
import type {SatelliteSummary} from '../satellites/types';
import {ScreenTitle} from '../components/ScreenTitle';
import {DEDICATED_SCREENS, hasSharedPreview, opensSharedInterface, ownScreenBeside} from './HomeScreen';
import {useDeveloperMode} from '../developer/DeveloperModeContext';
import {Surface} from '../components/Surface';
import {tokens, useAccent, useTopInset} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const {palette, space, type} = tokens;

type Props = NativeStackScreenProps<SatellitesStackParamList, 'SatellitesList'>;

/**
 * "Satellites" tab - lists whatever the *currently selected* server
 * reports (see "Fully modular satellite mobile architecture" in the task
 * brief): this screen never hard-codes a satellite's name. Individual
 * satellites are opened inside this section (SatelliteDetailScreen), never
 * added as their own bottom tab.
 */
export function SatellitesListScreen({navigation}: Props) {
  const {client} = useAuth();
  const {enabled: developer} = useDeveloperMode();
  const {activeServer} = useServers();
  const {color: accent} = useAccent();
  const top = useTopInset();
  const api = useMemo(() => new SatellitesApi(client), [client]);

  const [satellites, setSatellites] = useState<SatelliteSummary[] | null>(null);
  const [isCache, setIsCache] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeServer) {
      return;
    }
    const cached = await getCachedSatellites(activeServer.id);
    if (cached) {
      setSatellites(cached);
      setIsCache(true);
    }
    try {
      const live = await api.list();
      setSatellites(live);
      setIsCache(false);
      setError(null);
      await setCachedSatellites(activeServer.id, live);
    } catch (err: any) {
      if (!cached) {
        setError(err?.message || 'Could not load Satellites.');
      }
      // else: keep showing the cached list (isCache stays true) - see
      // "If a server is temporarily unavailable" in the task brief
    }
  }, [api, activeServer]);

  useEffect(() => {
    load();
  }, [load]);

  // and again on coming back to this tab, so an updated Satellite (a new
  // ui.json revision, say) is picked up without restarting the app
  useEffect(() => navigation.addListener?.('focus', load), [navigation, load]);

  return (
    <View style={styles.screen}>
      <FlatList
        ListFooterComponent={<FloatingPlayerSpacer />}
        // a satellite shown as a section of another (the Locked Folder, in
        // Photos) is opened from there, not listed on its own
        data={(satellites ?? []).filter(item => !item.section_of)}
        keyExtractor={item => item.name}
        contentContainerStyle={[styles.list, {paddingTop: top + space.xl}]}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenTitle eyebrow={activeServer?.name ? `StarCore · ${activeServer.name}` : 'StarCore'} title="Satellites" developerToggle />
            {isCache && <Text style={[type.caption, styles.offline]}>Showing cached data - offline</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
          </View>
        }
        renderItem={({item}) => {
          // a ui.json the Engine validated (UI contract 1.x) - drawn by the
          // generic SatelliteUiScreen, so a new Satellite needs no app change.
          // It comes first: a dedicated screen is what a Satellite without one
          // uses (Photo, Music), or the fallback for a server older than its ui.json. A
          // preview document (1.2) leaves the dedicated screen first; Developer Mode
          // offers the shared interface beside it. Otherwise Developer Mode offers the
          // dedicated screen beside the shared interface, until that screen is retired.
          const declarative = opensSharedInterface(item);
          const dedicated = declarative ? undefined : DEDICATED_SCREENS[item.name];
          const preview = developer && hasSharedPreview(item);
          const own = developer ? ownScreenBeside(item) : undefined;
          const openable = item.mobile_ui || Boolean(item.ui?.revision);
          return (
          <Pressable
            disabled={!openable}
            accessibilityRole="button"
            accessibilityLabel={openable ? `Open ${item.name}` : `${item.name}, no mobile interface yet`}
            style={({pressed}) => pressed && styles.pressed}
            onPress={() =>
              dedicated
                ? navigation.navigate(dedicated)
                : declarative
                  ? navigation.navigate('SatelliteUi', {name: item.name, revision: item.ui?.revision})
                  : navigation.navigate('SatelliteDetail', {name: item.name})
            }>
            <Surface style={styles.card}>
              <View style={styles.row}>
                <Icon name={satelliteIcon(item.name, item.icon_name)} size={20} color={accent} />
                <Text style={[type.title, styles.name]} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={[styles.dot, {backgroundColor: statusDotColor(item.status)}]} />
                <Text style={type.caption}>{STATUS_LABELS[item.status] ?? item.status}</Text>
                {openable && <Icon name="chevron-right" size={20} color={palette.text3} />}
              </View>
              <Text style={type.body} numberOfLines={2}>
                {item.description}
              </Text>
              {preview && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open the shared ${item.name} interface`}
                  testID={`shared-preview-${item.name}`}
                  onPress={() => navigation.navigate('SatelliteUi', {name: item.name, revision: item.ui?.revision})}
                  style={({pressed}) => [styles.previewPill, pressed && styles.pressed]}>
                  <Icon name="layers" size={14} color={palette.text2} />
                  <Text style={styles.previewLabel}>Shared interface (preview)</Text>
                </Pressable>
              )}
              {own && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.name}'s own screen`}
                  testID={`own-screen-${item.name}`}
                  onPress={() => navigation.navigate(own)}
                  style={({pressed}) => [styles.previewPill, pressed && styles.pressed]}>
                  <Icon name="layers" size={14} color={palette.text2} />
                  <Text style={styles.previewLabel}>Own screen (previous)</Text>
                </Pressable>
              )}
              {!openable && <Text style={styles.noUi}>No mobile interface yet</Text>}
            </Surface>
          </Pressable>
          );
        }}
        ListEmptyComponent={
          satellites !== null ? <Text style={type.body}>No Satellites are loaded on this server.</Text> : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  list: {paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md},
  header: {gap: space.sm, marginBottom: space.sm},
  card: {gap: space.md},
  previewPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: 999,
    backgroundColor: palette.control,
  },
  previewLabel: {...type.caption, color: palette.text2, fontWeight: '600'},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  name: {flex: 1, marginLeft: space.xs},
  dot: {width: 6, height: 6, borderRadius: 3},
  offline: {color: palette.text3},
  error: {color: palette.danger, fontSize: 13},
  noUi: {...type.caption, color: palette.text3},
  pressed: {opacity: 0.85},
});
