import {tokens} from '../theme';
import type {HealthState, WarningLevel} from './types';

/**
 * Units, shared with Mission Control's Status page:
 * - sizes (memory, swap, partitions, traffic totals) and disk throughput in
 *   binary units with IEC labels (KiB, MiB, GiB...), one decimal from KiB up
 * - network throughput in bits per second, decimal (kb/s, Mb/s, Gb/s), so it
 *   reads against an interface's link speed - the server reports bytes
 * - percentages with one decimal below 10% and from 90% to 100%, whole numbers otherwise
 * - a missing reading is "—", never a number
 */

export const MISSING = '—';
const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const BITS = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];

function known(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatBytes(value: number | null | undefined): string {
  if (!known(value)) {
    return MISSING;
  }
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < BINARY.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const sign = value < 0 ? '-' : '';
  return unit === 0 ? `${sign}${Math.round(amount)} B` : `${sign}${amount.toFixed(1)} ${BINARY[unit]}`;
}

/** Disk throughput: bytes per second, binary. */
export function formatByteRate(value: number | null | undefined): string {
  return known(value) ? `${formatBytes(value)}/s` : MISSING;
}

/** Network throughput: the server's bytes per second, shown as bits per second (decimal). */
export function formatBitRate(bytesPerSecond: number | null | undefined): string {
  if (!known(bytesPerSecond)) {
    return MISSING;
  }
  let amount = Math.max(bytesPerSecond, 0) * 8;
  let unit = 0;
  while (amount >= 1000 && unit < BITS.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  if (unit === 0) {
    return `${Math.round(amount)} ${BITS[0]}`;
  }
  return `${amount < 10 ? amount.toFixed(1) : Math.round(amount)} ${BITS[unit]}`;
}

/** An interface's link speed, as the server reports it (megabits per second). */
export function formatLinkSpeed(mbps: number | null | undefined): string {
  if (!known(mbps) || mbps <= 0) {
    return MISSING;
  }
  if (mbps >= 1000) {
    const gigabits = mbps / 1000;
    return `${Number.isInteger(gigabits) ? gigabits : gigabits.toFixed(1)} Gb/s`;
  }
  return `${Math.round(mbps)} Mb/s`;
}

/** One decimal below 10% and from 90% up to 100% - so 89.9% and 90.4% read differently
 * beside their warning colours - otherwise whole numbers. */
export function formatPercent(value: number | null | undefined): string {
  if (!known(value)) {
    return MISSING;
  }
  if (value >= 90 && value < 100) {
    return `${(Math.floor(value * 10) / 10).toFixed(1)}%`; // never "100.0%" for a disk that isn't full
  }
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

export function formatTemperature(celsius: number | null | undefined): string {
  return known(celsius) ? `${Math.round(celsius)} °C` : MISSING;
}

export function formatFrequency(mhz: number | null | undefined): string {
  if (!known(mhz) || mhz <= 0) {
    return MISSING;
  }
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
}

export function formatLoad(value: number | null | undefined): string {
  return known(value) ? value.toFixed(2) : MISSING;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!known(seconds) || seconds < 0) {
    return MISSING;
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${total}s`;
}

/** "just now", "12s ago", "5m ago", "2h ago", "3d ago" - for when a reading was taken. */
export function formatAgo(epochSeconds: number | null | undefined, nowMs: number = Date.now()): string {
  if (!known(epochSeconds)) {
    return MISSING;
  }
  const seconds = Math.max(0, Math.round(nowMs / 1000 - epochSeconds));
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

const pad = (value: number) => String(value).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A history point's time, as precise as its period needs (local time). */
export function formatPointTime(epochSeconds: number, period: string): string {
  const date = new Date(epochSeconds * 1000);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (period === '1h' || period === '24h') {
    return clock;
  }
  if (period === '7d') {
    return `${DAYS[date.getDay()]} ${clock}`;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`;
}

/** A value of a history series, by the unit the server gives it. */
export function formatSeriesValue(value: number | null | undefined, series: string): string {
  if (series === 'net_rx' || series === 'net_tx') {
    return formatBitRate(value);
  }
  if (series === 'disk_read' || series === 'disk_write') {
    return formatByteRate(value);
  }
  if (series === 'temperature') {
    return formatTemperature(value);
  }
  if (series === 'load') {
    return formatLoad(value);
  }
  return formatPercent(value);
}

export const HEALTH_LABELS: Record<HealthState, string> = {ok: 'Healthy', warning: 'Warning', critical: 'Critical'};

export function healthColor(state: HealthState | WarningLevel | null | undefined): string {
  if (state === 'critical') {
    return tokens.palette.danger;
  }
  if (state === 'warning') {
    return tokens.palette.warn;
  }
  return state === 'ok' ? tokens.palette.textIcon : tokens.palette.text3;
}

/** Where a usage figure crosses into a warning or a critical state - the
 * same limits the server raises its warnings at (health.py). */
export const LIMITS = {
  cpu: [90, 98],
  memory: [90, 97],
  swap: [80, 95],
  storage: [90, 97],
  temperature: [85, 95],
} as const;

export function levelFor(value: number | null | undefined, limits: readonly [number, number]): HealthState | null {
  if (!known(value)) {
    return null;
  }
  if (value >= limits[1]) {
    return 'critical';
  }
  return value >= limits[0] ? 'warning' : 'ok';
}
