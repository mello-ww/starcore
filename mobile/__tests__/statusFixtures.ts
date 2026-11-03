import type {StatusHistory, StatusSnapshot} from '../src/status/types';

/** A snapshot shaped like a real Windows server's (no load average, no temperature). */
export function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    node: {id: 'local', name: 'atlas', kind: 'local'},
    interval: 5,
    sampling: true,
    sampled_at: 1_730_000_000,
    health: {
      state: 'warning',
      warnings: [{id: 'storage:D:\\', level: 'warning', title: 'D:\\ is almost full', detail: '90% used, 179.2 GB free'}],
    },
    cpu: {
      percent: 29.8,
      per_core: [42.4, 48.5, 12.1, 36.4],
      logical_cores: 4,
      physical_cores: 2,
      model: 'Intel(R) Core(TM) i5-10600KF CPU @ 4.10GHz',
      load: null,
      frequency: {current_mhz: 4496, max_mhz: null, base_mhz: 4104},
      temperature: null,
    },
    memory: {
      total: 34_276_085_760,
      available: 8_558_297_088,
      used: 25_717_788_672,
      percent: 75,
      swap: {total: 21_888_929_792, used: 187_293_696, free: 21_701_636_096, percent: 0.9},
    },
    storage: {
      partitions: [
        {mount: 'C:\\', fs: 'NTFS', kind: 'fixed', label: null, total: 321_146_318_848, used: 288_833_241_088, free: 32_313_077_760, percent: 89.9},
        {mount: 'D:\\', fs: 'NTFS', kind: 'fixed', label: 'Data', total: 2_000_381_014_016, used: 1_807_969_128_448, free: 192_411_885_568, percent: 90.4},
      ],
      partitions_read_at: 1_730_000_000,
      stale: false,
      io: {
        read_bps: 57_273,
        write_bps: 8_182,
        disks: [{name: 'Disk 0', volumes: 'C:', read_bps: 57_273, write_bps: 8_182, busy_percent: 0.1}],
      },
    },
    network: {
      rx_bps: 1822,
      tx_bps: 142,
      interfaces: [
        {
          name: 'Ethernet 2', kind: 'ethernet', up: true, speed_mbps: 2500, rx_bytes: 76_261_458_470, tx_bytes: 21_564_613_581,
          rx_errors: 0, tx_errors: 0, rx_drops: 587, tx_drops: 0, rx_bps: 1822, tx_bps: 142,
        },
        {
          name: 'Wi-Fi', kind: 'wifi', up: false, speed_mbps: null, rx_bytes: 0, tx_bytes: 0,
          rx_errors: 0, tx_errors: 0, rx_drops: 0, tx_drops: 0, rx_bps: 0, tx_bps: 0,
        },
      ],
    },
    system: {
      os: 'Windows 11 Pro', kernel: '10.0.26200', architecture: 'AMD64', hostname: 'atlas',
      cpu_model: 'Intel(R) Core(TM) i5-10600KF CPU @ 4.10GHz', physical_cores: 2, vendor: 'Gigabyte', model: 'Z490 UD',
      uptime_seconds: 683_519, boot_time: 1_729_316_481, platform: 'Windows', python: '3.14.7',
    },
    process: {cpu_percent: 0.2, memory: 29_000_000},
    services: {
      engine: {
        name: 'StarCore', running: true, uptime_seconds: 3720, commands: 11, satellite_services: true,
        mission_control: {enabled: true, running: true},
      },
      healthy: true,
      checks: [{check: 'engine', ok: true, detail: 'running'}],
      satellites: [
        {name: 'Music', version: '1.0.0', type: 'native', enabled: true, status: 'running', service: true, last_error: null, commands: ['music']},
        {name: 'Photo', version: '1.0.0', type: 'native', enabled: true, status: 'error', service: true,
          last_error: 'start hook of satellite \'Photo\' failed: port in use', commands: ['photo']},
        {name: 'LockedFolder', version: '1.0.0', type: 'native', enabled: true, status: 'running', service: false, last_error: null, commands: ['locked']},
      ],
      online: 2,
      total: 3,
      dependencies: [{satellite: 'LockedFolder', needs: 'Photo', kind: 'section'}],
      components: [
        {name: 'Pillow', kind: 'python', available: true, used_for: 'Photo and Locked Folder thumbnails'},
        {name: 'FFmpeg', kind: 'program', available: false, used_for: 'Music transcoding and video thumbnails'},
      ],
    },
    unsupported: {
      'cpu.load': 'Windows has no load average',
      'cpu.temperature': 'Windows exposes no CPU temperature without vendor tools or administrator WMI access',
    },
    collect_ms: 1.6,
    ...overrides,
  };
}

/** 24 hours as 60 points of 24 minutes each, with a five-point gap where StarCore was off. */
export function history(overrides: Partial<StatusHistory> = {}): StatusHistory {
  const from = 1_730_000_000;
  const resolution = 1440;
  const points = (value: number) =>
    Array.from({length: 60}, (_, index) => index)
      .filter(index => index < 20 || index >= 25) // five slots missing: a gap
      .map(index => [from + index * resolution, value + (index % 5), value + 10] as [number, number, number]);
  return {
    period: '24h',
    resolution,
    from,
    to: from + 60 * resolution,
    sampling: true,
    interval: 5,
    series: {
      cpu: {unit: '%', points: points(30)},
      memory: {unit: '%', points: points(70)},
      net_rx: {unit: 'B/s', points: points(2000)},
      net_tx: {unit: 'B/s', points: points(300)},
      temperature: {unit: '°C', points: []},
      load: {unit: '', points: []},
    },
    ...overrides,
  };
}
