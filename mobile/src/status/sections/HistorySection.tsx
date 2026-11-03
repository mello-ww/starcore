import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {TOUCH_TARGET, tokens, useAccent, useAccentStyles} from '../../theme';
import type {StatusApi} from '../api';
import {ChartSeries, ColumnChart} from '../charts';
import {SectionCard} from '../components';
import {useStatusHistory} from '../hooks';
import {HISTORY_PERIODS, HistoryPeriod, SeriesName, StatusSnapshot} from '../types';

const {palette, radii, space, type} = tokens;

/** Columns per chart: enough to read a trend, few enough Views to stay smooth. */
export const HISTORY_POINTS = 60;

const PERIOD_LABELS: Record<HistoryPeriod, string> = {'1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days'};

interface ChartDefinition {
  title: string;
  series: {key: SeriesName; label: string}[];
  /** The `unsupported` key that explains an empty chart, if the server gives one. */
  reason?: string;
}

const CHARTS: ChartDefinition[] = [
  {title: 'CPU', series: [{key: 'cpu', label: 'CPU'}], reason: 'cpu.percent'},
  {title: 'Memory', series: [{key: 'memory', label: 'Memory'}], reason: 'memory'},
  {title: 'Network', series: [{key: 'net_rx', label: 'Download'}, {key: 'net_tx', label: 'Upload'}], reason: 'network'},
  {title: 'Disk', series: [{key: 'disk_read', label: 'Read'}, {key: 'disk_write', label: 'Write'}], reason: 'storage.io'},
  {title: 'Temperature', series: [{key: 'temperature', label: 'CPU'}], reason: 'cpu.temperature'},
  {title: 'Load', series: [{key: 'load', label: '1 minute'}], reason: 'cpu.load'},
  {title: 'Swap', series: [{key: 'swap', label: 'Swap'}]},
  {title: 'Fullest partition', series: [{key: 'storage', label: 'Used'}]},
];

export function HistorySection({api, active, snapshot}: {api: StatusApi; active: boolean; snapshot: StatusSnapshot | null}) {
  const {color: accent} = useAccent();
  const accentStyle = useAccentStyles();
  const [period, setPeriod] = useState<HistoryPeriod>('24h');
  const history = useStatusHistory(api, period, active, {points: HISTORY_POINTS});
  const data = history.data;
  const unsupported = snapshot?.unsupported ?? {};

  const shown: {definition: ChartDefinition; series: ChartSeries[]}[] = [];
  const missing: {title: string; reason: string}[] = [];
  for (const definition of CHARTS) {
    const series = definition.series.map((line, index) => ({
      key: line.key,
      label: line.label,
      color: index === 0 ? accent : palette.chart2,
      points: data?.series[line.key]?.points ?? [],
    }));
    if (series.some(line => line.points.length > 0)) {
      shown.push({definition, series});
    } else if (definition.reason && unsupported[definition.reason]) {
      missing.push({title: definition.title, reason: unsupported[definition.reason]});
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.periods} accessibilityRole="tablist">
        {HISTORY_PERIODS.map(item => (
          <Pressable
            key={item}
            onPress={() => setPeriod(item)}
            accessibilityRole="tab"
            accessibilityState={{selected: period === item}}
            accessibilityLabel={`Last ${PERIOD_LABELS[item]}`}
            style={[styles.period, period === item && accentStyle.fill]}
            testID={`history-period-${item}`}>
            <Text style={[type.label, styles.periodLabel, period === item && [styles.periodActive, accentStyle.onFill]]}>{item}</Text>
          </Pressable>
        ))}
      </View>

      {history.error && (
        <SectionCard title="History">
          <Text style={type.body}>{history.error}</Text>
          <Pressable onPress={history.refresh} accessibilityRole="button" style={({pressed}) => [styles.retry, pressed && styles.pressed]}>
            <Text style={type.label}>Try again</Text>
          </Pressable>
        </SectionCard>
      )}

      {!data && !history.error && [0, 1].map(index => <View key={index} style={styles.skeleton} />)}

      {data && shown.length === 0 && (
        <SectionCard title="History">
          <Text style={type.body}>
            {data.sampling
              ? `No readings recorded in the last ${PERIOD_LABELS[period]} yet.`
              : `Nothing recorded in the last ${PERIOD_LABELS[period]}. History is kept while the Status service runs, and it isn't running on this server right now.`}
          </Text>
        </SectionCard>
      )}

      {data &&
        shown.map(({definition, series}) => (
          <View key={definition.title} style={styles.card}>
            <ColumnChart
              title={series.length > 1 ? definition.title : `${definition.title} · last ${PERIOD_LABELS[period]}`}
              series={series}
              from={data.from}
              to={data.to}
              resolution={data.resolution}
              period={period}
              dimmed={history.loading}
            />
          </View>
        ))}

      {data && missing.length > 0 && (
        <SectionCard title="Not recorded here">
          {missing.map(item => (
            <View key={item.title} style={styles.missing}>
              <Text style={type.label}>{item.title}</Text>
              <Text style={[type.caption, styles.muted]}>{item.reason}</Text>
            </View>
          ))}
        </SectionCard>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: space.md},
  periods: {flexDirection: 'row', backgroundColor: palette.card, borderRadius: radii.control, padding: 3, gap: 3},
  period: {flex: 1, minHeight: TOUCH_TARGET, borderRadius: radii.control - 3, alignItems: 'center', justifyContent: 'center'},
  periodLabel: {color: palette.text2},
  periodActive: {fontWeight: '700'},
  card: {padding: space.lg, borderRadius: radii.card, backgroundColor: palette.card},
  skeleton: {height: 200, borderRadius: radii.card, backgroundColor: palette.card},
  retry: {
    alignSelf: 'flex-start',
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderRadius: radii.control,
    backgroundColor: palette.controlStrong,
  },
  pressed: {opacity: 0.8},
  missing: {gap: 2},
  muted: {color: palette.text3},
});
