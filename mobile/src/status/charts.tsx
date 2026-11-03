import React, {useMemo, useState} from 'react';
import {LayoutChangeEvent, Pressable, StyleSheet, Text, View} from 'react-native';
import {TOUCH_TARGET, tokens} from '../theme';
import {formatPointTime, formatSeriesValue} from './format';
import type {HistoryPoint} from './types';

const {palette, radii, space, type} = tokens;
const MAX_SLOTS = 240;
const PERCENT_SERIES = new Set(['cpu', 'memory', 'swap', 'storage']);

export interface ChartSeries {
  /** The history series name - it decides the units. */
  key: string;
  label: string;
  color: string;
  points: HistoryPoint[];
}

export interface Slot {
  start: number;
  /** One average per series, or null where there is no reading (StarCore was off). */
  values: (number | null)[];
  peaks: (number | null)[];
}

/**
 * Lays the points on a fixed time grid from `from` to `to`, one slot per
 * `resolution` seconds. A slot no point falls into stays empty: a gap is
 * shown as a gap, never bridged.
 */
export function buildSlots(series: ChartSeries[], from: number, to: number, resolution: number): Slot[] {
  const span = Math.max(1, to - from);
  const count = Math.max(1, Math.min(MAX_SLOTS, Math.ceil(span / Math.max(1, resolution))));
  // with more points than slots, each slot covers several: the grid always spans the whole period
  const step = Math.max(1, resolution, Math.ceil(span / count));
  const sums = Array.from({length: count}, () => series.map(() => 0));
  const counts = Array.from({length: count}, () => series.map(() => 0));
  const peaks: (number | null)[][] = Array.from({length: count}, () => series.map(() => null));
  series.forEach((line, index) => {
    for (const [start, average, peak] of line.points) {
      const slot = Math.floor((start - from) / step);
      if (slot < 0 || slot >= count) {
        continue;
      }
      sums[slot][index] += average;
      counts[slot][index] += 1;
      const current = peaks[slot][index];
      peaks[slot][index] = current === null ? peak : Math.max(current, peak);
    }
  });
  return sums.map((row, slot) => ({
    start: from + slot * step,
    values: row.map((total, index) => (counts[slot][index] ? total / counts[slot][index] : null)),
    peaks: peaks[slot],
  }));
}

function niceCeil(value: number): number {
  if (!(value > 0)) {
    return 1;
  }
  const base = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * base >= value) {
      return step * base;
    }
  }
  return 10 * base;
}

/** The top of the y-axis: 100% for usage, otherwise a round number above the highest value drawn. */
export function chartMax(series: string, peak: number): number {
  if (PERCENT_SERIES.has(series)) {
    return 100;
  }
  if (series === 'net_rx' || series === 'net_tx') {
    return niceCeil(peak * 8) / 8; // round in bits, the unit it is shown in
  }
  if (series === 'disk_read' || series === 'disk_write') {
    if (!(peak > 0)) {
      return 1024;
    }
    let base = 1;
    while (peak / base >= 1024) {
      base *= 1024;
    }
    return niceCeil(peak / base) * base;
  }
  return niceCeil(peak);
}

interface ColumnChartProps {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  resolution: number;
  period: string;
  height?: number;
  /** Held at reduced opacity while a new range loads, instead of blanking. */
  dimmed?: boolean;
}

/** A column chart built from Views (no SVG on this app), with a readout for
 * the column under the finger and a table of every value behind a toggle. */
export function ColumnChart({title, series, from, to, resolution, period, height = 120, dimmed}: ColumnChartProps) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const slots = useMemo(() => buildSlots(series, from, to, resolution), [series, from, to, resolution]);
  const key = series[0]?.key ?? '';
  // scaled to the averages the columns draw; a brief peak would flatten them (peaks stay in the readout)
  const highest = Math.max(0, ...slots.flatMap(slot => slot.values.map(value => value ?? 0)));
  const max = chartMax(key, highest);
  const slotWidth = width / slots.length;
  const barWidth = Math.max(1, Math.min(24, (slotWidth - 2) / Math.max(series.length, 1) - (series.length > 1 ? 1 : 0)));
  const radius = Math.min(4, barWidth / 2);
  const filled = slots.filter(slot => slot.values.some(value => value !== null));
  const active = selected !== null && slots[selected] ? slots[selected] : null;

  const pick = (x: number) => {
    if (slotWidth > 0) {
      setSelected(Math.min(slots.length - 1, Math.max(0, Math.floor(x / slotWidth))));
    }
  };

  const readout = active
    ? `${formatPointTime(active.start, period)} · ` +
      series
        .map((line, index) =>
          active.values[index] === null
            ? `${line.label} no reading`
            : `${line.label} ${formatSeriesValue(active.values[index], line.key)} (peak ${formatSeriesValue(active.peaks[index], line.key)})`,
        )
        .join(' · ')
    : summary(series, slots);

  return (
    <View style={[styles.chart, dimmed && styles.dimmed]}>
      <View style={styles.head}>
        <Text style={[type.eyebrow, styles.title]}>{title.toUpperCase()}</Text>
        {series.length > 1 && (
          <View style={styles.legend}>
            {series.map(line => (
              <View key={line.key} style={styles.legendItem}>
                <View style={[styles.swatch, {backgroundColor: line.color}]} />
                <Text style={type.caption}>{line.label}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <Text style={[type.caption, styles.readout]} numberOfLines={2} testID="chart-readout">
        {readout}
      </Text>
      <View style={styles.plotRow}>
        <View
          style={[styles.plot, {height}]}
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={event => pick(event.nativeEvent.locationX)}
          onResponderMove={event => pick(event.nativeEvent.locationX)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`${title} chart`}
          accessibilityValue={{text: readout}}
          accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
          onAccessibilityAction={event => {
            const step = event.nativeEvent.actionName === 'increment' ? 1 : -1;
            setSelected(current => Math.min(slots.length - 1, Math.max(0, (current ?? slots.length - 1) + step)));
          }}
          testID="chart-plot">
          <View style={[styles.grid, {top: 0}]} />
          <View style={[styles.grid, {top: height / 2}]} />
          <View style={styles.columns}>
            {slots.map((slot, index) => {
              const empty = slot.values.every(value => value === null);
              return (
                <View key={slot.start} style={styles.slot} testID={empty ? 'chart-gap' : 'chart-slot'}>
                  {empty ? (
                    <View style={styles.gap} />
                  ) : (
                    series.map((line, lineIndex) => {
                      const value = slot.values[lineIndex];
                      const barHeight = value === null ? 0 : Math.max(value > 0 ? 1 : 0, Math.min(1, value / max) * height);
                      return (
                        <View
                          key={line.key}
                          style={{
                            width: barWidth,
                            height: barHeight,
                            marginHorizontal: series.length > 1 ? 0.5 : 0,
                            backgroundColor: line.color,
                            borderTopLeftRadius: radius,
                            borderTopRightRadius: radius,
                            opacity: selected === null || selected === index ? 1 : 0.4,
                          }}
                        />
                      );
                    })
                  )}
                </View>
              );
            })}
          </View>
        </View>
        <View style={[styles.axis, {height}]}>
          <Text style={styles.tick}>{formatSeriesValue(max, key)}</Text>
          <Text style={styles.tick}>{formatSeriesValue(max / 2, key)}</Text>
          <Text style={styles.tick}>0</Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={styles.tick}>{formatPointTime(from, period)}</Text>
        <Text style={styles.tick}>Now</Text>
      </View>
      <Pressable
        onPress={() => setShowTable(value => !value)}
        accessibilityRole="button"
        accessibilityState={{expanded: showTable}}
        accessibilityLabel={showTable ? `Hide ${title} values` : `Show ${title} values`}
        style={({pressed}) => [styles.toggle, pressed && styles.pressed]}>
        <Text style={type.caption}>{showTable ? 'Hide values' : 'Show values'}</Text>
      </Pressable>
      {showTable && (
        <View style={styles.table} testID="chart-table">
          {filled.length === 0 && <Text style={type.caption}>No readings in this range.</Text>}
          {[...filled].reverse().map(slot => (
            <View key={slot.start} style={styles.tableRow}>
              <Text style={[type.caption, styles.tableTime]}>{formatPointTime(slot.start, period)}</Text>
              {series.map((line, index) => (
                <Text key={line.key} style={[type.caption, styles.tableValue]}>
                  {`${series.length > 1 ? `${line.label} ` : ''}${formatSeriesValue(slot.values[index], line.key)}`}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function summary(series: ChartSeries[], slots: Slot[]): string {
  return series
    .map((line, index) => {
      const values = slots.map(slot => slot.values[index]).filter((value): value is number => value !== null);
      if (!values.length) {
        return `${line.label}: no readings yet`;
      }
      const average = values.reduce((total, value) => total + value, 0) / values.length;
      const peak = Math.max(...slots.map(slot => slot.peaks[index] ?? -Infinity));
      return `${line.label} avg ${formatSeriesValue(average, line.key)}, peak ${formatSeriesValue(peak, line.key)}`;
    })
    .join(' · ');
}

/** One thin bar per CPU core, 0-100%. */
export function CoreBars({values, color}: {values: number[]; color: string}) {
  return (
    <View
      style={styles.cores}
      accessible
      accessibilityLabel={`Per-core usage: ${values.map(value => `${Math.round(value)}%`).join(', ')}`}>
      {values.map((value, index) => (
        <View key={index} style={styles.core}>
          <View style={[styles.coreFill, {height: `${Math.max(2, Math.min(100, value))}%`, backgroundColor: color}]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: {gap: space.sm},
  dimmed: {opacity: 0.55},
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md},
  title: {flexShrink: 1},
  legend: {flexDirection: 'row', gap: space.md},
  legendItem: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
  swatch: {width: 10, height: 10, borderRadius: 2},
  readout: {minHeight: 34},
  plotRow: {flexDirection: 'row', gap: space.sm},
  plot: {flex: 1, justifyContent: 'flex-end'},
  grid: {position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.controlStrong},
  columns: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.controlStrong,
  },
  slot: {flex: 1, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center'},
  gap: {width: 2, height: 2, borderRadius: 1, backgroundColor: palette.controlStrong},
  axis: {justifyContent: 'space-between', alignItems: 'flex-end', minWidth: 44},
  tick: {fontSize: 11, color: palette.text3},
  footer: {flexDirection: 'row', justifyContent: 'space-between', marginRight: 52},
  toggle: {alignSelf: 'flex-start', minHeight: TOUCH_TARGET, justifyContent: 'center'},
  pressed: {opacity: 0.7},
  table: {gap: space.xs, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.controlStrong},
  tableRow: {flexDirection: 'row', gap: space.md},
  tableTime: {width: 92, color: palette.text3},
  tableValue: {flex: 1},
  cores: {flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 40},
  core: {flex: 1, height: '100%', justifyContent: 'flex-end', borderRadius: radii.control / 4, backgroundColor: palette.control},
  coreFill: {borderTopLeftRadius: 2, borderTopRightRadius: 2},
});
