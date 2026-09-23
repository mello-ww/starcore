import React, {useCallback, useEffect, useState} from 'react';
import {RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {Card} from '../components/Card';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

/** Mirrors GET /api/status (see docs/api.md) - only the fields this screen
 * actually shows. */
interface EngineStatus {
  engine: string;
  running: boolean;
  uptime_seconds: number;
  satellites: {total: number; native: number; link: number};
  commands: number;
}

/**
 * The Overview tab: a summary of the *currently selected* StarCore server
 * - see "New mobile bottom navigation" in the task brief. Reuses
 * `GET /api/status`, the exact same endpoint Mission Control's own
 * dashboard is built on; nothing here is a second implementation of it.
 */
export function OverviewScreen() {
  const {client} = useAuth();
  const {activeServer} = useServers();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const {status: httpStatus, body} = await client.get('/api/status');
      if (httpStatus !== 200) {
        throw new Error('Could not reach this StarCore server.');
      }
      setStatus(body as EngineStatus);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not reach this StarCore server.');
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={styles.screen}>
      <Starfield />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.azure} />}>
        <Text style={typography.title}>{activeServer?.name ?? 'StarCore'}</Text>
        <Text style={typography.caption}>{activeServer?.baseUrl}</Text>

        {error ? (
          <Card style={styles.card}>
            <Text style={typography.heading}>Unreachable</Text>
            <Text style={[typography.caption, styles.gap]}>{error}</Text>
          </Card>
        ) : status ? (
          <Card style={styles.card}>
            <View style={styles.row}>
              <Text style={typography.label}>ENGINE</Text>
              <Text style={typography.body}>{status.engine}</Text>
            </View>
            <View style={styles.row}>
              <Text style={typography.label}>STATUS</Text>
              <Text style={typography.body}>{status.running ? 'Running' : 'Stopped'}</Text>
            </View>
            <View style={styles.row}>
              <Text style={typography.label}>UPTIME</Text>
              <Text style={typography.body}>{formatUptime(status.uptime_seconds)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={typography.label}>SATELLITES</Text>
              <Text style={typography.body}>
                {status.satellites.total} ({status.satellites.native} native, {status.satellites.link} link)
              </Text>
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  card: {gap: spacing.sm},
  row: {flexDirection: 'row', justifyContent: 'space-between'},
  gap: {marginTop: spacing.xs},
});
