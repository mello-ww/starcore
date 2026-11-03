import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import type {SatelliteSummary} from '../satellites/types';
import {TOUCH_TARGET, tokens} from '../theme';
import {statusSummary} from './api';
import {Dot, Meter} from './components';
import {HEALTH_LABELS, LIMITS, MISSING, formatPercent, healthColor, levelFor} from './format';

const {palette, radii, space, type} = tokens;

/**
 * Home's compact Status card. It reads the summary the Status satellite
 * publishes with every satellite listing - the list Home already loads - so
 * it adds no request of its own. Hidden when this server has no (enabled)
 * Status satellite, or one that doesn't publish a summary yet.
 */
export function StatusWidget({satellite, onOpen}: {satellite: SatelliteSummary | undefined; onOpen: () => void}) {
  const summary = satellite && satellite.enabled ? statusSummary(satellite.state) : null;
  if (!summary) {
    return null;
  }
  const label = HEALTH_LABELS[summary.health];
  const satellites =
    summary.satellites_online !== null && summary.satellites_total !== null
      ? `${summary.satellites_online}/${summary.satellites_total}`
      : MISSING;
  // the server lists the most serious first and sends at most three titles
  const shown = summary.warnings.slice(0, 2);
  const hidden = Math.max(summary.warning_count, summary.warnings.length) - shown.length;

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Status: ${label}, CPU ${formatPercent(summary.cpu_percent)}, memory ${formatPercent(summary.memory_percent)}. Open Status`}
      style={({pressed}) => [styles.card, pressed && styles.pressed]}
      testID="home-status-widget">
      <View style={styles.head}>
        <Text style={type.eyebrow}>STATUS</Text>
        <View style={styles.state}>
          <Dot color={healthColor(summary.health)} />
          <Text style={type.label}>{label}</Text>
        </View>
        <Icon name="chevron-right" size={20} color={palette.text3} />
      </View>
      <View style={styles.metrics}>
        <Metric label="CPU" value={formatPercent(summary.cpu_percent)}>
          <Meter value={summary.cpu_percent} level={levelFor(summary.cpu_percent, LIMITS.cpu)} label="CPU usage" />
        </Metric>
        <Metric label="RAM" value={formatPercent(summary.memory_percent)}>
          <Meter value={summary.memory_percent} level={levelFor(summary.memory_percent, LIMITS.memory)} label="Memory usage" />
        </Metric>
        <Metric label="SATELLITES" value={satellites} />
      </View>
      {shown.map((warning, index) => (
        <View key={warning} style={styles.warning}>
          <Dot color={healthColor(index === 0 && summary.health === 'critical' ? 'critical' : 'warning')} size={6} />
          <Text style={[type.caption, styles.warningText]} numberOfLines={1}>
            {warning}
          </Text>
        </View>
      ))}
      {hidden > 0 ? <Text style={[type.caption, styles.more]}>{`+${hidden} more`}</Text> : null}
    </Pressable>
  );
}

function Metric({label, value, children}: {label: string; value: string; children?: React.ReactNode}) {
  return (
    <View style={styles.metric}>
      <Text style={[type.eyebrow, styles.metricLabel]}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: TOUCH_TARGET,
    padding: space.lg,
    borderRadius: radii.card,
    backgroundColor: palette.card,
    gap: space.md,
  },
  pressed: {opacity: 0.85},
  head: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  state: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm},
  metrics: {flexDirection: 'row', gap: space.lg},
  metric: {flex: 1, gap: space.xs},
  metricLabel: {fontSize: 10, letterSpacing: 1.6},
  metricValue: {...type.title, fontSize: 20},
  warning: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  warningText: {flex: 1},
  more: {color: palette.text3},
});
