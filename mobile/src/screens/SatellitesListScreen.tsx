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
import {Surface} from '../components/Surface';
import {tokens, useAccent, useTopInset} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';

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

  return (
    <View style={styles.screen}>
      <FlatList
        data={satellites ?? []}
        keyExtractor={item => item.name}
        contentContainerStyle={[styles.list, {paddingTop: top + space.xl}]}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenTitle eyebrow={activeServer?.name ? `StarCore · ${activeServer.name}` : 'StarCore'} title="Satellites" />
            {isCache && <Text style={[type.caption, styles.offline]}>Showing cached data - offline</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
          </View>
        }
        renderItem={({item}) => (
          <Pressable
            disabled={!item.mobile_ui}
            accessibilityRole="button"
            accessibilityLabel={item.mobile_ui ? `Open ${item.name}` : `${item.name}, no mobile interface yet`}
            style={({pressed}) => pressed && styles.pressed}
            onPress={() =>
              // "Photo" gets its own dedicated screens (grid, folders,
              // search, a full-screen viewer) instead of the generic
              // DeclarativeScreen every other Satellite renders through -
              // see PhotoHomeScreen's docstring. Still gated on
              // item.mobile_ui like everything else: Photo only reaches
              // here at all because it now answers a "mobile" route too
              // (see satellites/native/photo/api.py).
              item.name === 'Photo'
                ? navigation.navigate('PhotoHome')
                : item.name === 'Music'
                  ? navigation.navigate('MusicHome')
                  : navigation.navigate('SatelliteDetail', {name: item.name})
            }>
            <Surface style={styles.card}>
              <View style={styles.row}>
                <Icon name={satelliteIcon(item.name)} size={20} color={accent} />
                <Text style={[type.title, styles.name]} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={[styles.dot, {backgroundColor: statusDotColor(item.status)}]} />
                <Text style={type.caption}>{STATUS_LABELS[item.status] ?? item.status}</Text>
                {item.mobile_ui && <Icon name="chevron-right" size={20} color={palette.text3} />}
              </View>
              <Text style={type.body} numberOfLines={2}>
                {item.description}
              </Text>
              {!item.mobile_ui && <Text style={styles.noUi}>No mobile interface yet</Text>}
            </Surface>
          </Pressable>
        )}
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
  row: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  name: {flex: 1, marginLeft: space.xs},
  dot: {width: 6, height: 6, borderRadius: 3},
  offline: {color: palette.text3},
  error: {color: palette.danger, fontSize: 13},
  noUi: {...type.caption, color: palette.text3},
  pressed: {opacity: 0.85},
});
