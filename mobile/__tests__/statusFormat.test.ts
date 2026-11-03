import {
  MISSING,
  formatAgo,
  formatBitRate,
  formatByteRate,
  formatBytes,
  formatDuration,
  formatFrequency,
  formatLinkSpeed,
  formatPercent,
  formatPointTime,
  formatSeriesValue,
  formatTemperature,
  healthColor,
  levelFor,
  LIMITS,
} from '../src/status/format';
import {statusSummary} from '../src/status/api';
import {tokens} from '../src/theme';

describe('Status units', () => {
  it('shows sizes in binary units with one decimal from KiB up', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(34_276_085_760)).toBe('31.9 GiB');
    expect(formatBytes(8_001_545_039_872)).toBe('7.3 TiB');
    expect(formatByteRate(57_273)).toBe('55.9 KiB/s');
  });

  it('shows network throughput as decimal bits per second', () => {
    expect(formatBitRate(142)).toBe('1.1 kb/s'); // 1,136 b/s
    expect(formatBitRate(1822)).toBe('15 kb/s');
    expect(formatBitRate(125_000_000)).toBe('1.0 Gb/s');
    expect(formatBitRate(10)).toBe('80 b/s');
    expect(formatLinkSpeed(2500)).toBe('2.5 Gb/s');
    expect(formatLinkSpeed(1000)).toBe('1 Gb/s');
    expect(formatLinkSpeed(100)).toBe('100 Mb/s');
  });

  it('shows percentages, temperatures and frequencies the agreed way', () => {
    expect(formatPercent(7.44)).toBe('7.4%');
    expect(formatPercent(42.4)).toBe('42%');
    expect(formatPercent(89.9)).toBe('90%');
    expect(formatPercent(90.4)).toBe('90.4%');
    expect(formatPercent(99.96)).toBe('99.9%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatTemperature(54.4)).toBe('54 °C');
    expect(formatFrequency(4493)).toBe('4.49 GHz');
    expect(formatFrequency(800)).toBe('800 MHz');
  });

  it('never turns a missing reading into a number', () => {
    for (const format of [formatBytes, formatByteRate, formatBitRate, formatPercent, formatTemperature, formatFrequency, formatLinkSpeed, formatDuration]) {
      expect(format(null)).toBe(MISSING);
      expect(format(undefined)).toBe(MISSING);
    }
    expect(formatPercent(Number.NaN)).toBe(MISSING);
  });

  it('formats durations and how long ago a reading was taken', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(3720)).toBe('1h 2m');
    expect(formatDuration(683_519)).toBe('7d 21h');
    const now = 1_730_000_100_000;
    expect(formatAgo(1_730_000_099, now)).toBe('just now');
    expect(formatAgo(1_730_000_070, now)).toBe('30s ago');
    expect(formatAgo(1_729_999_800, now)).toBe('5m ago');
  });

  it('formats a history value by its series', () => {
    expect(formatSeriesValue(12.5, 'cpu')).toBe('13%');
    expect(formatSeriesValue(1822, 'net_rx')).toBe('15 kb/s');
    expect(formatSeriesValue(2048, 'disk_write')).toBe('2.0 KiB/s');
    expect(formatSeriesValue(0.5, 'load')).toBe('0.50');
    expect(formatPointTime(1_730_000_000, '24h')).toMatch(/^\d\d:\d\d$/);
    expect(formatPointTime(1_730_000_000, '7d')).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
  });

  it('colours health by state and finds the warning levels the server uses', () => {
    expect(healthColor('ok')).toBe(tokens.palette.textIcon);
    expect(healthColor('warning')).toBe(tokens.palette.warn);
    expect(healthColor('critical')).toBe(tokens.palette.danger);
    expect(levelFor(50, LIMITS.cpu)).toBe('ok');
    expect(levelFor(91, LIMITS.memory)).toBe('warning');
    expect(levelFor(97.5, LIMITS.storage)).toBe('critical');
    expect(levelFor(null, LIMITS.cpu)).toBeNull();
  });
});

describe('statusSummary', () => {
  it('reads the summary the Status satellite publishes', () => {
    expect(
      statusSummary({health: 'warning', cpu_percent: 12, memory_percent: 75, satellites_online: 3, satellites_total: 6,
        warnings: ['D:\\ is almost full', 7], warning_count: 4}),
    ).toEqual({health: 'warning', cpu_percent: 12, memory_percent: 75, satellites_online: 3, satellites_total: 6,
      warnings: ['D:\\ is almost full'], warning_count: 4});
  });

  it('ignores a state without a known health value (an older server)', () => {
    expect(statusSummary(undefined)).toBeNull();
    expect(statusSummary({platform: 'Windows', python: '3.13'})).toBeNull();
    expect(statusSummary({health: 'great'})).toBeNull();
  });
});
