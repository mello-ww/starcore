import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {tokens, useAccent} from '../../theme';
import type {StatusApi} from '../api';
import {ColumnChart} from '../charts';
import {Meter, SectionCard, Tile, WarningList} from '../components';
import {
  LIMITS,
  MISSING,
  formatBitRate,
  formatBytes,
  formatDuration,
  formatFrequency,
  formatLinkSpeed,
  formatPercent,
  levelFor,
} from '../format';
import {useStatusHistory} from '../hooks';
import type {StatusSnapshot} from '../types';

const {palette, space, type} = tokens;

export function busiestPartition(data: StatusSnapshot) {
  const partitions = (data.storage?.partitions ?? []).filter(
    item => item.percent !== null && (item.kind === 'fixed' || item.kind === 'removable'),
  );
  return partitions.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;
}

export function OverviewSection({data, api, active}: {data: StatusSnapshot; api: StatusApi; active: boolean}) {
  const {color: accent} = useAccent();
  const history = useStatusHistory(api, '1h', active, {series: ['cpu', 'memory'], points: 60});
  const cpu = data.cpu;
  const memory = data.memory;
  const disk = busiestPartition(data);
  const network = data.network;
  const link = network?.interfaces.find(item => item.up && item.kind !== 'loopback' && item.kind !== 'virtual');
  const cores = cpu?.logical_cores ? `${cpu.logical_cores} threads` : null;
  const frequency = cpu?.frequency?.current_mhz ? formatFrequency(cpu.frequency.current_mhz) : null;

  return (
    <View style={styles.wrap}>
      <SectionCard title="Warnings" testID="status-warnings">
        <WarningList warnings={data.health.warnings} />
      </SectionCard>

      <View style={styles.tiles}>
        <Tile label="CPU" value={formatPercent(cpu?.percent)} caption={[cores, frequency].filter(Boolean).join(' · ') || undefined}>
          <Meter value={cpu?.percent} level={levelFor(cpu?.percent, LIMITS.cpu)} label="CPU usage" />
        </Tile>
        <Tile
          label="Memory"
          value={formatPercent(memory?.percent)}
          caption={memory ? `${formatBytes(memory.used)} of ${formatBytes(memory.total)}` : 'Not available'}>
          <Meter value={memory?.percent} level={levelFor(memory?.percent, LIMITS.memory)} label="Memory usage" />
        </Tile>
        <Tile
          label="Storage"
          value={disk ? formatPercent(disk.percent) : MISSING}
          caption={disk ? `${disk.mount} · ${formatBytes(disk.free)} free` : 'No local partitions reported'}>
          <Meter value={disk?.percent} level={levelFor(disk?.percent, LIMITS.storage)} label="Fullest partition" />
        </Tile>
        <Tile
          label="Network"
          value={network ? `↓ ${formatBitRate(network.rx_bps)}` : MISSING}
          caption={
            network
              ? `↑ ${formatBitRate(network.tx_bps)}${link ? ` · ${link.name}${link.speed_mbps ? ` ${formatLinkSpeed(link.speed_mbps)}` : ''}` : ''}`
              : data.unsupported.network ?? 'Not available'
          }
        />
        <Tile
          label="Satellites"
          value={`${data.services.online}/${data.services.total}`}
          caption={data.services.online === data.services.total ? 'All online' : `${data.services.total - data.services.online} not running`}
        />
        <Tile
          label="Uptime"
          value={formatDuration(data.system?.uptime_seconds)}
          caption={`StarCore up ${formatDuration(data.services.engine.uptime_seconds)}`}
        />
      </View>

      <SectionCard title="Last hour">
        {history.data ? (
          // two charts rather than one with interleaved columns: each reads on its own
          <>
            <ColumnChart
              title="CPU"
              period="1h"
              from={history.data.from}
              to={history.data.to}
              resolution={history.data.resolution}
              dimmed={history.loading}
              series={[{key: 'cpu', label: 'CPU', color: accent, points: history.data.series.cpu?.points ?? []}]}
            />
            <ColumnChart
              title="Memory"
              period="1h"
              from={history.data.from}
              to={history.data.to}
              resolution={history.data.resolution}
              dimmed={history.loading}
              series={[{key: 'memory', label: 'Memory', color: accent, points: history.data.series.memory?.points ?? []}]}
            />
          </>
        ) : history.error ? (
          <Text style={type.body}>{history.error}</Text>
        ) : (
          <View style={styles.chartSkeleton} />
        )}
        {history.data && !history.data.sampling && (
          <Text style={type.caption}>History is recorded while the Status service runs - it isn't running right now.</Text>
        )}
      </SectionCard>

      <Text style={[type.caption, styles.footnote]}>
        {data.sampling
          ? `Sampled every ${data.interval}s${data.collect_ms !== undefined ? ` · last reading took ${data.collect_ms} ms` : ''}`
          : 'Readings are taken on request: the Status service is not running.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: space.md},
  tiles: {flexDirection: 'row', flexWrap: 'wrap', gap: space.md},
  chartSkeleton: {height: 160, borderRadius: 12, backgroundColor: palette.control},
  footnote: {color: palette.text3, textAlign: 'center'},
});
