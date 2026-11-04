import React, {useMemo, useState} from 'react';
import {LayoutChangeEvent, Pressable, StyleSheet, Text, View} from 'react-native';
import {TOUCH_TARGET, tokens} from '../theme';

const {palette, radii, space, type} = tokens;
const MAX_SLOTS = 240;

/**
 * The app's shared charts, meters and sparklines, drawn with Views (the app
 * has no SVG). The UI contract renderer draws the `chart` block and a
 * metric's trend with them, and Satellite-specific screens may use them
 * too. They know values, times and formatters, never a Satellite.
 */

/** [time, average, peak?] - the shape history routes return. */
export type ChartPoint = [number, number, number?] | number[];

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

export interface Slot {
  start: number;
  /** One average per series, or null where there is no reading. */
  values: (number | null)[];
  peaks: (number | null)[];
}

/** How an axis rounds: to 100 for percentages, in bits, in powers of 1024, or plainly. */
export type ChartScale = 'percent' | 'bits' | 'bytes' | 'plain';

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
    for (const point of line.points) {
      const [start, average] = point;
      const peak = typeof point[2] === 'number' ? point[2] : average;
      const slot = Math.floor((start - from) / step);
      if (slot < 0 || slot >= count || typeof average !== 'number') {
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

/** The top of a y-axis: 100 for percentages, otherwise a round number above the highest value drawn. */
export function niceMax(peak: number, scale: ChartScale): number {
  if (scale === 'percent') {
    return 100;
  }
  if (scale === 'bits') {
    return niceCeil(peak * 8) / 8; // round in bits, the unit it is shown in
  }
  if (scale === 'bytes') {
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

export interface ColumnChartProps {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  resolution: number;
  /** A value as text, for the readout, the axis and the table. */
  format: (value: number | null | undefined) => string;
  /** A slot's start time as text. */
  timeLabel: (epochSeconds: number) => string;
  scale?: ChartScale;
  /** A fixed top for the axis; otherwise one is chosen from the values drawn. */
  max?: number | null;
  height?: number;
  /** Held at reduced opacity while a new range loads, instead of blanking. */
  dimmed?: boolean;
  /** What an empty chart says. */
  empty?: string;
}

/** A column chart built from Views, with a readout for the column under the
 * finger and a table of every value behind a toggle. */
export function ColumnChart({
  title, series, from, to, resolution, format, timeLabel, scale = 'plain', max: fixedMax, height = 120, dimmed, empty,
}: ColumnChartProps) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const slots = useMemo(() => buildSlots(series, from, to, resolution), [series, from, to, resolution]);
  // scaled to the averages the columns draw; a brief peak would flatten them (peaks stay in the readout)
  const highest = Math.max(0, ...slots.flatMap(slot => slot.values.map(value => value ?? 0)));
  const max = fixedMax && fixedMax > 0 ? fixedMax : niceMax(highest, scale);
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
    ? `${timeLabel(active.start)} · ` +
      series
        .map((line, index) =>
          active.values[index] === null
            ? `${line.label} no reading`
            : `${line.label} ${format(active.values[index])} (peak ${format(active.peaks[index])})`,
        )
        .join(' · ')
    : filled.length === 0 && empty
      ? empty
      : summary(series, slots, format);

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
              const gap = slot.values.every(value => value === null);
              return (
                <View key={slot.start} style={styles.slot} testID={gap ? 'chart-gap' : 'chart-slot'}>
                  {gap ? (
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
          <Text style={styles.tick}>{format(max)}</Text>
          <Text style={styles.tick}>{format(max / 2)}</Text>
          <Text style={styles.tick}>0</Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={styles.tick}>{timeLabel(from)}</Text>
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
          {filled.length === 0 && <Text style={type.caption}>{empty || 'No readings in this range.'}</Text>}
          {[...filled].reverse().map(slot => (
            <View key={slot.start} style={styles.tableRow}>
              <Text style={[type.caption, styles.tableTime]}>{timeLabel(slot.start)}</Text>
              {series.map((line, index) => (
                <Text key={line.key} style={[type.caption, styles.tableValue]}>
                  {`${series.length > 1 ? `${line.label} ` : ''}${format(slot.values[index])}`}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function summary(series: ChartSeries[], slots: Slot[], format: (value: number) => string): string {
  return series
    .map((line, index) => {
      const values = slots.map(slot => slot.values[index]).filter((value): value is number => value !== null);
      if (!values.length) {
        return `${line.label}: no readings yet`;
      }
      const average = values.reduce((total, value) => total + value, 0) / values.length;
      const peak = Math.max(...slots.map(slot => slot.peaks[index] ?? -Infinity));
      return `${line.label} avg ${format(average)}, peak ${format(peak)}`;
    })
    .join(' · ');
}

/** One thin bar per value, against a fixed top (per-core usage, say). */
export function Bars({values, color, max = 100, label}: {values: number[]; color: string; max?: number; label?: string}) {
  return (
    <View
      style={styles.cores}
      accessible
      accessibilityLabel={label ?? values.map(value => `${Math.round(value)}`).join(', ')}>
      {values.map((value, index) => (
        <View key={index} style={styles.core}>
          <View style={[styles.coreFill, {height: `${Math.max(2, Math.min(100, (value / (max || 1)) * 100))}%`, backgroundColor: color}]} />
        </View>
      ))}
    </View>
  );
}

/** A tiny trend for a stat tile: muted columns, the latest in the accent. */
export function Sparkline({values, accent, height = 24}: {values: number[]; accent: string; height?: number}) {
  const known = values.filter(value => typeof value === 'number' && Number.isFinite(value)).slice(-40);
  if (known.length < 2) {
    return null;
  }
  const low = Math.min(...known);
  const high = Math.max(...known);
  const range = high - low || 1;
  return (
    <View style={[styles.spark, {height}]} importantForAccessibility="no-hide-descendants" testID="sparkline">
      {known.map((value, index) => (
        <View
          key={index}
          style={[
            styles.sparkBar,
            {
              height: Math.max(2, ((value - low) / range) * (height - 2) + 2),
              backgroundColor: index === known.length - 1 ? accent : palette.chart2,
            },
          ]}
        />
      ))}
    </View>
  );
}

export type MeterLevel = 'warning' | 'critical' | null | undefined;

/** A usage bar, 0-100. The fill carries severity - neutral, then warning, then danger - never the
 * accent, which with the default red would make a normal bar look critical. */
export function Meter({value, level, label}: {value: number | null | undefined; level?: MeterLevel | 'ok'; label: string}) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const fill = level === 'critical' ? palette.danger : level === 'warning' ? palette.warn : palette.textIcon;
  return (
    <View
      style={styles.track}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={known ? {min: 0, max: 100, now: Math.round(value)} : {text: 'Unavailable'}}>
      {known && <View style={[styles.fill, {width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: fill}]} />}
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
  spark: {flexDirection: 'row', alignItems: 'flex-end', gap: 1, marginTop: space.xs},
  sparkBar: {flex: 1, borderTopLeftRadius: 1, borderTopRightRadius: 1},
  track: {height: 6, borderRadius: 3, backgroundColor: palette.controlStrong, overflow: 'hidden'},
  fill: {height: '100%', borderRadius: 3},
});
