import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {SatellitesApi} from '../satellites/api';
import {getCachedSatellites, setCachedSatellites} from '../satellites/cache';
import type {SatelliteSummary} from '../satellites/types';
import {Card} from '../components/Card';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';

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
      <Starfield count={20} />
      <View style={styles.content}>
        <Text style={typography.title}>Satellites</Text>
        {isCache && <Text style={[typography.caption, styles.offline]}>Showing cached data - offline</Text>}
        {error && <Text style={styles.error}>{error}</Text>}
        <FlatList
          data={satellites ?? []}
          keyExtractor={item => item.name}
          contentContainerStyle={styles.list}
          renderItem={({item}) => (
            <Pressable
              disabled={!item.mobile_ui}
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
                  : navigation.navigate('SatelliteDetail', {name: item.name})
              }>
              <Card style={styles.card}>
                <View style={styles.row}>
                  <Text style={typography.heading}>{item.name}</Text>
                  <Text style={[typography.caption, statusColor(item.status)]}>{item.status}</Text>
                </View>
                <Text style={typography.caption}>{item.description}</Text>
                {!item.mobile_ui && <Text style={styles.noUi}>No mobile interface yet</Text>}
              </Card>
            </Pressable>
          )}
          ListEmptyComponent={
            satellites !== null ? <Text style={typography.caption}>No Satellites are loaded on this server.</Text> : null
          }
        />
      </View>
    </View>
  );
}

function statusColor(status: SatelliteSummary['status']) {
  if (status === 'running') {
    return {color: colors.ok};
  }
  if (status === 'error') {
    return {color: colors.alert};
  }
  return {color: colors.textFaint};
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.sm},
  list: {gap: spacing.sm, paddingBottom: spacing.lg},
  card: {gap: spacing.xs},
  row: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  offline: {color: colors.textFaint},
  error: {color: colors.alert, fontSize: 13},
  noUi: {color: colors.textFaint, fontSize: 12, fontStyle: 'italic'},
});
