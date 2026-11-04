import {useIsFocused} from '@react-navigation/native';
import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {TOUCH_TARGET, tokens, useAccent, useAccentStyles} from '../theme';
import {StatusApi} from './api';
import {HealthPill} from './components';
import {formatAgo} from './format';
import {useAppActive, useStatusMetrics} from './hooks';
import {HardwareSection} from './sections/HardwareSection';
import {HistorySection} from './sections/HistorySection';
import {NetworkSection} from './sections/NetworkSection';
import {OverviewSection} from './sections/OverviewSection';
import {ServicesSection} from './sections/ServicesSection';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const {palette, radii, space, type} = tokens;

export type StatusSectionKey = 'overview' | 'hardware' | 'network' | 'services' | 'history';
export const STATUS_SECTIONS: {key: StatusSectionKey; label: string}[] = [
  {key: 'overview', label: 'Overview'},
  {key: 'hardware', label: 'Hardware'},
  {key: 'network', label: 'Network'},
  {key: 'services', label: 'Services'},
  {key: 'history', label: 'History'},
];

/**
 * The Status satellite's native screen - what the Satellites tab and Home
 * open for "Status" instead of its generic declarative screen. One metrics
 * poller feeds every section; it runs only while this screen is focused and
 * the app is in the foreground (see useStatusMetrics).
 */
export function StatusHomeScreen() {
  const {client} = useAuth();
  const api = useMemo(() => new StatusApi(client), [client]);
  const focused = useIsFocused();
  const appActive = useAppActive();
  const active = focused && appActive;
  const metrics = useStatusMetrics(api, active);
  const {color: accent} = useAccent();
  const accentStyle = useAccentStyles();
  const [section, setSection] = useState<StatusSectionKey>('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // keeps "updated 12s ago" honest between polls
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [active]);

  const onRefresh = async () => {
    setRefreshing(true);
    await metrics.refresh();
    setRefreshing(false);
  };

  const data = metrics.data;
  const name = data?.node.name || data?.system?.hostname || 'This server';
  const updated = metrics.updatedAt ? formatAgo(metrics.updatedAt / 1000, now) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={type.eyebrow}>STATUS</Text>
        <View style={styles.titleRow}>
          <Text style={[type.display, styles.title]} numberOfLines={1}>
            {name}
          </Text>
          {data && <HealthPill state={data.health.state} />}
        </View>
        <Text style={type.caption} testID="status-updated">
          {data ? `${data.system?.os ?? data.system?.platform ?? ''}${updated ? ` · updated ${updated}` : ''}` : 'Connecting…'}
        </Text>
        <View style={styles.segments} accessibilityRole="tablist">
          {STATUS_SECTIONS.map(item => (
            <Pressable
              key={item.key}
              onPress={() => setSection(item.key)}
              accessibilityRole="tab"
              accessibilityState={{selected: section === item.key}}
              accessibilityLabel={item.label}
              testID={`status-tab-${item.key}`}
              style={[styles.segment, section === item.key && accentStyle.fill]}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[styles.segmentLabel, section === item.key && [styles.segmentLabelActive, accentStyle.onFill]]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
            progressBackgroundColor={palette.card}
          />
        }>
        {metrics.stale && (
          <View style={styles.offline} accessibilityRole="alert">
            <Text style={[type.label, styles.offlineText]}>Offline</Text>
            <Text style={type.caption}>
              {`Showing the last reading${updated ? ` from ${updated}` : ''}. ${metrics.error}`}
            </Text>
          </View>
        )}

        {metrics.loading && section !== 'history' && (
          <View testID="status-loading" style={styles.loading}>
            {[0, 1, 2].map(index => (
              <View key={index} style={styles.skeleton} />
            ))}
          </View>
        )}

        {!data && metrics.error && section !== 'history' && (
          <View style={styles.errorCard}>
            <Text style={type.title}>Status is unavailable</Text>
            <Text style={type.body}>{metrics.error}</Text>
            <Pressable
              onPress={metrics.refresh}
              accessibilityRole="button"
              testID="status-retry"
              style={({pressed}) => [styles.retry, pressed && styles.pressed]}>
              <Text style={type.label}>Try again</Text>
            </Pressable>
          </View>
        )}

        {data && section === 'overview' && <OverviewSection data={data} api={api} active={active} />}
        {data && section === 'hardware' && <HardwareSection data={data} />}
        {data && section === 'network' && <NetworkSection data={data} />}
        {data && section === 'services' && <ServicesSection data={data} />}
        {section === 'history' && <HistorySection api={api} active={active} snapshot={data} />}
        <FloatingPlayerSpacer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  header: {paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, gap: space.xs},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  title: {flex: 1, fontSize: 26, lineHeight: 32},
  segments: {
    flexDirection: 'row',
    marginTop: space.md,
    backgroundColor: palette.card,
    borderRadius: radii.control,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 2,
    borderRadius: radii.control - 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentLabel: {...type.caption, color: palette.text2},
  segmentLabelActive: {fontWeight: '700'},
  content: {paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md},
  offline: {
    padding: space.md,
    borderRadius: radii.control,
    backgroundColor: palette.control,
    borderLeftWidth: 3,
    borderLeftColor: palette.warn,
    gap: 2,
  },
  offlineText: {color: palette.warn},
  loading: {gap: space.md},
  skeleton: {height: 120, borderRadius: radii.card, backgroundColor: palette.card},
  errorCard: {padding: space.xl, borderRadius: radii.card, backgroundColor: palette.card, gap: space.sm},
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
});
