import React from 'react';
import {
  Bars,
  ChartScale,
  ChartSeries as SharedSeries,
  ColumnChart as SharedColumnChart,
  buildSlots as sharedBuildSlots,
  niceMax,
} from '../components/charts';
import {formatPointTime, formatSeriesValue} from './format';
import type {HistoryPoint} from './types';

/**
 * The Status screen's charts: the app's shared charts (components/charts.tsx),
 * told how each Status history series is scaled and formatted. The UI
 * contract renderer draws the same shared components for any Satellite.
 */

const PERCENT_SERIES = new Set(['cpu', 'memory', 'swap', 'storage']);

export interface ChartSeries {
  /** The history series name - it decides the units. */
  key: string;
  label: string;
  color: string;
  points: HistoryPoint[];
}

export type {Slot} from '../components/charts';

export function buildSlots(series: ChartSeries[], from: number, to: number, resolution: number) {
  return sharedBuildSlots(series as SharedSeries[], from, to, resolution);
}

function scaleOf(series: string): ChartScale {
  if (PERCENT_SERIES.has(series)) {
    return 'percent';
  }
  if (series === 'net_rx' || series === 'net_tx') {
    return 'bits';
  }
  if (series === 'disk_read' || series === 'disk_write') {
    return 'bytes';
  }
  return 'plain';
}

/** The top of the y-axis: 100% for usage, otherwise a round number above the highest value drawn. */
export function chartMax(series: string, peak: number): number {
  return niceMax(peak, scaleOf(series));
}

interface ColumnChartProps {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  resolution: number;
  period: string;
  height?: number;
  dimmed?: boolean;
}

export function ColumnChart({series, period, ...props}: ColumnChartProps) {
  const key = series[0]?.key ?? '';
  return (
    <SharedColumnChart
      {...props}
      series={series as SharedSeries[]}
      scale={scaleOf(key)}
      format={value => formatSeriesValue(value, key)}
      timeLabel={time => formatPointTime(time, period)}
    />
  );
}

/** One thin bar per CPU core, 0-100%. */
export function CoreBars({values, color}: {values: number[]; color: string}) {
  return (
    <Bars values={values} color={color} label={`Per-core usage: ${values.map(value => `${Math.round(value)}%`).join(', ')}`} />
  );
}
