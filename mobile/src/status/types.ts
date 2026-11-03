/** Mirrors the Status satellite's routes - see satellites/native/status/api.py
 * and docs/satellites/status.md in the main repository. Every reading can be
 * null: the server reports why under `unsupported`, and this app shows that
 * instead of a value - it never fills one in. */

export type HealthState = 'ok' | 'warning' | 'critical';
export type WarningLevel = 'warning' | 'critical';

export interface StatusWarning {
  id: string;
  level: WarningLevel;
  title: string;
  detail: string;
}

export interface CpuReading {
  percent: number | null;
  per_core: number[] | null;
  logical_cores: number | null;
  physical_cores: number | null;
  model: string | null;
  load: {'1m': number; '5m': number; '15m': number} | null;
  frequency: {current_mhz: number | null; max_mhz?: number | null; base_mhz?: number | null} | null;
  temperature: {current: number; sensors: {label: string; celsius: number}[]} | null;
}

export interface MemoryReading {
  total: number;
  available: number;
  used: number;
  percent: number | null;
  swap: {total: number; used: number; free: number; percent: number | null};
}

export interface Partition {
  mount: string;
  fs: string | null;
  kind: 'fixed' | 'removable' | 'network' | 'ramdisk' | string;
  label?: string | null;
  total: number;
  used: number;
  free: number;
  percent: number | null;
}

export interface DiskIo {
  name: string;
  volumes?: string | null;
  read_bps: number | null;
  write_bps: number | null;
  busy_percent: number | null;
}

export interface StorageReading {
  partitions: Partition[];
  partitions_read_at: number | null;
  stale: boolean;
  io: {read_bps: number | null; write_bps: number | null; disks: DiskIo[]} | null;
}

export interface NetworkInterface {
  name: string;
  kind: 'ethernet' | 'wifi' | 'virtual' | 'loopback' | 'other' | string;
  up: boolean;
  speed_mbps: number | null;
  rx_bytes: number;
  tx_bytes: number;
  rx_errors: number;
  tx_errors: number;
  rx_drops: number;
  tx_drops: number;
  rx_bps: number | null;
  tx_bps: number | null;
}

export interface NetworkReading {
  rx_bps: number | null;
  tx_bps: number | null;
  interfaces: NetworkInterface[];
}

export interface SystemReading {
  os: string | null;
  kernel: string | null;
  architecture: string | null;
  hostname: string | null;
  cpu_model: string | null;
  physical_cores: number | null;
  vendor: string | null;
  model: string | null;
  uptime_seconds: number | null;
  boot_time: number | null;
  platform: string | null;
  python: string | null;
}

export interface ServiceSatellite {
  name: string;
  version: string;
  type: string;
  enabled: boolean;
  status: 'running' | 'stopped' | 'disabled' | 'error';
  service: boolean;
  last_error: string | null;
  commands: string[];
}

export interface ServicesReading {
  engine: {
    name: string;
    running: boolean;
    uptime_seconds: number;
    commands: number;
    satellite_services: boolean;
    mission_control: {enabled: boolean; running: boolean};
  };
  healthy: boolean;
  checks: {check: string; ok: boolean; detail: string}[];
  satellites: ServiceSatellite[];
  online: number;
  total: number;
  dependencies: {satellite: string; needs: string; kind: string}[];
  components: {name: string; kind: string; available: boolean; used_for: string}[];
}

export interface StatusSnapshot {
  node: {id: string; name: string | null; kind: string};
  interval: number;
  sampling: boolean;
  sampled_at: number;
  health: {state: HealthState; warnings: StatusWarning[]};
  cpu: CpuReading | null;
  memory: MemoryReading | null;
  storage: StorageReading | null;
  network: NetworkReading | null;
  system: SystemReading | null;
  process: {cpu_percent: number | null; memory: number | null} | null;
  services: ServicesReading;
  unsupported: Record<string, string>;
  collect_ms?: number;
}

export type HistoryPeriod = '1h' | '24h' | '7d' | '30d';
export const HISTORY_PERIODS: HistoryPeriod[] = ['1h', '24h', '7d', '30d'];

export type SeriesName =
  | 'cpu'
  | 'memory'
  | 'swap'
  | 'load'
  | 'temperature'
  | 'disk_read'
  | 'disk_write'
  | 'net_rx'
  | 'net_tx'
  | 'storage';

/** [bucket start (epoch seconds), average, peak] */
export type HistoryPoint = [number, number, number];

export interface StatusHistory {
  period: HistoryPeriod;
  /** Seconds each point covers. */
  resolution: number;
  from: number;
  to: number;
  sampling: boolean;
  interval: number;
  series: Partial<Record<SeriesName, {unit: string; points: HistoryPoint[]}>>;
}

/** What the Status satellite publishes with every satellite listing (its state.py). */
export interface StatusSummary {
  health: HealthState;
  cpu_percent: number | null;
  memory_percent: number | null;
  satellites_online: number | null;
  satellites_total: number | null;
  warnings: string[];
  warning_count: number;
}
