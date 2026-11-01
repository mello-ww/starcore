import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {SatellitesApi} from '../satellites/api';
import {DeclarativeScreen} from '../satellites/DeclarativeScreen';
import type {UiScreen} from '../satellites/types';
import {colors, spacing, useAccentStyles} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'SatelliteDetail'>;

/**
 * A single Satellite's screen, rendered entirely from what its "mobile"
 * route describes (see "Exposing a mobile interface" in
 * docs/satellites.md) - this component has no idea which Satellite it's
 * showing beyond its name, and needs no changes for a new one to work.
 */
export function SatelliteDetailScreen({route, navigation}: Props) {
  const accentStyle = useAccentStyles();
  const {name} = route.params;
  const {client} = useAuth();
  const api = useMemo(() => new SatellitesApi(client), [client]);

  const [screen, setScreen] = useState<UiScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const {screen: loaded} = await api.mobileUi(name);
      setScreen(loaded);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load this Satellite.');
    }
  }, [api, name]);

  useEffect(() => {
    navigation.setOptions({title: name});
    load();
  }, [load, name, navigation]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const runAction = async (action: Parameters<typeof api.runAction>[1]) => {
    try {
      await api.runAction(name, action);
      await load(); // most actions change something this screen displays
    } catch (err: any) {
      setError(err?.message || 'That action failed.');
    }
  };

  if (error && !screen) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!screen) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={accentStyle.color} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accentStyle.color} />}>
      {error && <Text style={styles.error}>{error}</Text>}
      <DeclarativeScreen screen={screen} onAction={runAction} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {padding: spacing.lg, gap: spacing.md},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.void, padding: spacing.lg},
  error: {color: colors.alert, fontSize: 13},
});
