import {useFocusEffect, useNavigation} from '@react-navigation/native';
import React, {useCallback, useMemo, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import {useAuth} from '../auth/AuthContext';
import {SatellitesApi} from '../satellites/api';
import {STATUS_LABELS, satelliteIcon, statusDotColor as dotColor} from '../satellites/icons';
import type {SatelliteSummary} from '../satellites/types';
import {useServers} from '../servers/ServersContext';
import {TOUCH_TARGET, tokens, useAccent} from '../theme';

const {palette, radii, space, type, ACCENTS} = tokens;

interface EngineStatus {
  engine: string;
  running: boolean;
  uptime_seconds: number;
  commands: number;
}

export function greeting(name: string): string {
  return name ? `Welcome back, ${name}` : 'Welcome back';
}

export function formatUptime(seconds: number): string {
  const total = Math.floor(seconds || 0);
  if (total < 60) {
    return `${total}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function alertsFor(satellites: SatelliteSummary[]) {
  return satellites
    .filter(satellite => satellite.status === 'error' || satellite.status === 'stopped')
    .map(satellite => ({
      satellite,
      text:
        satellite.status === 'error'
          ? `${satellite.name} reported an error`
          : `${satellite.name} is enabled but not running`,
    }));
}

/** The first tab: a greeting, the selected server's state and its Satellites. */
export function HomeScreen() {
  const {client} = useAuth();
  const {activeServer} = useServers();
  const {accent, color: accentColor, setAccent} = useAccent();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const api = useMemo(() => new SatellitesApi(client), [client]);

  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [satellites, setSatellites] = useState<SatelliteSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    client
      .get('/api/auth/status')
      .then(({body}) => setName(typeof body?.username === 'string' ? body.username : ''))
      .catch(() => {});
    try {
      const [{status: httpStatus, body}, list] = await Promise.all([client.get('/api/status'), api.list()]);
      if (httpStatus !== 200) {
        throw new Error('Could not reach this StarCore server.');
      }
      setStatus(body as EngineStatus);
      setSatellites(list);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not reach this StarCore server.');
    }
  }, [client, api]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const open = (satellite: SatelliteSummary) => {
    const screen =
      satellite.name === 'Photo' ? 'PhotoHome' : satellite.name === 'Music' ? 'MusicHome' : 'SatelliteDetail';
    const params = screen === 'SatelliteDetail' ? {name: satellite.name} : undefined;
    navigation.navigate('Satellites', {screen, params, initial: false});
  };

  const online = satellites?.filter(satellite => satellite.status === 'running').length ?? 0;
  const alerts = satellites ? alertsFor(satellites) : [];
  const loading = !status && !error;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, {paddingTop: insets.top + space.xl}]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accentColor} colors={[accentColor]} progressBackgroundColor={palette.card} />}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={type.eyebrow} numberOfLines={1}>
              {`STARCORE${activeServer?.name ? ` · ${activeServer.name.toUpperCase()}` : ''}`}
            </Text>
            <Text style={[type.display, styles.greeting]} testID="home-greeting">
              {greeting(name)}
            </Text>
          </View>
          <Pressable
            onPress={() => setPicking(value => !value)}
            accessibilityRole="button"
            accessibilityLabel="Accent colour"
            accessibilityState={{expanded: picking}}
            style={({pressed}) => [styles.iconButton, pressed && styles.pressed]}>
            <Icon name="droplet" size={20} color={palette.textIcon} />
          </Pressable>
        </View>

        {picking && (
          <View style={styles.picker} accessibilityRole="radiogroup" accessibilityLabel="Accent colour">
            {ACCENTS.map(option => (
              <Pressable
                key={option.name}
                onPress={() => {
                  setAccent(option.name);
                  setPicking(false);
                }}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{checked: option.name === accent}}
                testID={`accent-${option.name}`}
                style={styles.swatchTarget}>
                <View style={[styles.swatchRing, option.name === accent && styles.swatchRingActive]}>
                  <View style={[styles.swatch, {backgroundColor: option.color}]} />
                </View>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.statusCard}>
          <DotMatrix />
          <Text style={type.eyebrow}>SYSTEM</Text>
          {error ? (
            <>
              <View style={styles.stateRow}>
                <View style={[styles.dot, {backgroundColor: dotColor('offline')}]} />
                <Text style={styles.state}>Unreachable</Text>
              </View>
              <Text style={type.body}>{error}</Text>
              <Pressable
                onPress={onRefresh}
                accessibilityRole="button"
                style={({pressed}) => [styles.button, styles.buttonSecondary, styles.retry, pressed && styles.pressed]}>
                <Text style={type.label}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.stateRow}>
                <View
                  style={[
                    styles.dot,
                    {backgroundColor: status ? dotColor(status.running ? (alerts.length ? 'stopped' : 'running') : 'error') : palette.text3},
                  ]}
                />
                <Text style={styles.state}>{status ? (status.running ? 'Online' : 'Stopped') : 'Connecting'}</Text>
              </View>
              <Text style={type.body}>
                {status
                  ? `${status.engine} is running${alerts.length ? ` · ${alerts.length} alert${alerts.length === 1 ? '' : 's'}` : ''}`
                  : 'Waiting for StarCore to answer.'}
              </Text>
              <View style={styles.metrics}>
                <Metric label="UPTIME" value={status ? formatUptime(status.uptime_seconds) : '—'} />
                <Metric label="ONLINE" value={status && satellites ? `${online}/${satellites.length}` : '—'} />
                <Metric label="COMMANDS" value={status ? String(status.commands) : '—'} />
              </View>
            </>
          )}
        </View>

        <View style={styles.sectionHead}>
          <Text style={type.eyebrow}>SATELLITES</Text>
          {satellites && satellites.length > 0 && <Text style={type.caption}>{`${online} of ${satellites.length} online`}</Text>}
        </View>

        {loading && [0, 1].map(index => <View key={index} style={[styles.card, styles.skeleton]} />)}
        {satellites?.length === 0 && <Text style={[type.body, styles.empty]}>No Satellites are loaded on this server.</Text>}
        {satellites?.map(satellite => (
          <View key={satellite.name} style={styles.card}>
            <View style={styles.cardHead}>
              <Icon name={satelliteIcon(satellite.name)} size={20} color={accentColor} />
              <Text style={[type.title, styles.cardTitle]} numberOfLines={1}>
                {satellite.name}
              </Text>
              <View style={[styles.dotSmall, {backgroundColor: dotColor(satellite.status)}]} />
              <Text style={type.caption}>{STATUS_LABELS[satellite.status] ?? satellite.status}</Text>
            </View>
            <Text style={[type.body, styles.cardDesc]} numberOfLines={2}>
              {satellite.description}
            </Text>
            {satellite.mobile_ui ? (
              <Pressable
                onPress={() => open(satellite)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${satellite.name}`}
                style={({pressed}) => [styles.button, {backgroundColor: accentColor}, pressed && styles.pressed]}>
                <Icon name="arrow-up-right" size={18} color={palette.onAccent} />
                <Text style={[type.label, {color: palette.onAccent}]}>Open</Text>
              </Pressable>
            ) : (
              <Text style={type.caption}>No mobile interface yet</Text>
            )}
          </View>
        ))}

        {satellites && (
          <>
            <View style={styles.sectionHead}>
              <Text style={type.eyebrow}>ALERTS</Text>
            </View>
            {alerts.length === 0 ? (
              <Text style={[type.body, styles.empty]}>No alerts. Every enabled satellite is running.</Text>
            ) : (
              alerts.map(alert => (
                <View key={alert.satellite.name} style={styles.alert}>
                  <View style={[styles.dot, {backgroundColor: dotColor(alert.satellite.status)}]} />
                  <Text style={[type.label, styles.alertText]}>{alert.text}</Text>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.metric}>
      <Text style={[type.eyebrow, styles.metricLabel]}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const DOT_COLUMNS = 9;
const DOT_ROWS = 6;

/** A faint dot-matrix field in the status card's corner. */
function DotMatrix() {
  return (
    <View style={styles.matrix} pointerEvents="none">
      {Array.from({length: DOT_ROWS}, (_, row) => (
        <View key={row} style={styles.matrixRow}>
          {Array.from({length: DOT_COLUMNS}, (__, column) => (
            <View key={column} style={[styles.matrixDot, {opacity: 0.04 + (column / DOT_COLUMNS) * 0.1}]} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md},
  header: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginBottom: space.sm},
  headerText: {flex: 1, gap: space.sm},
  greeting: {marginTop: 2},
  iconButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: radii.control,
    backgroundColor: palette.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {opacity: 0.8},
  picker: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: space.sm,
    borderRadius: radii.card,
    backgroundColor: palette.card,
  },
  swatchTarget: {width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center'},
  swatchRing: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRingActive: {borderColor: palette.text},
  swatch: {width: 26, height: 26, borderRadius: 13},
  statusCard: {
    overflow: 'hidden',
    padding: space.xl,
    borderRadius: radii.card,
    backgroundColor: palette.card,
    gap: space.xs,
  },
  matrix: {position: 'absolute', top: space.lg, right: space.lg, gap: 9},
  matrixRow: {flexDirection: 'row', gap: 9},
  matrixDot: {width: 3, height: 3, borderRadius: 1.5, backgroundColor: palette.text},
  stateRow: {flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm},
  state: {...type.display, fontSize: 26, lineHeight: 32},
  dot: {width: 8, height: 8, borderRadius: 4},
  dotSmall: {width: 6, height: 6, borderRadius: 3},
  metrics: {flexDirection: 'row', marginTop: space.lg},
  metric: {flex: 1, gap: space.xs},
  metricLabel: {fontSize: 10, letterSpacing: 1.6},
  metricValue: {...type.title, fontSize: 20},
  retry: {alignSelf: 'flex-start', marginTop: space.md},
  sectionHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.md, marginTop: space.lg},
  card: {padding: space.lg, borderRadius: radii.card, backgroundColor: palette.card},
  skeleton: {height: 140},
  cardHead: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  cardTitle: {flex: 1, marginLeft: space.xs},
  cardDesc: {marginTop: space.md, marginBottom: space.lg},
  button: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.xl,
    borderRadius: radii.control,
  },
  buttonSecondary: {backgroundColor: palette.controlStrong},
  empty: {paddingVertical: space.sm},
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radii.control,
    backgroundColor: palette.card,
  },
  alertText: {flex: 1},
});
