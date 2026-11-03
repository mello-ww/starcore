import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {tokens, useAccent} from '../../theme';
import {CoreBars} from '../charts';
import {Meter, Row, SectionCard, Unsupported} from '../components';
import {
  LIMITS,
  MISSING,
  formatByteRate,
  formatBytes,
  formatDuration,
  formatFrequency,
  formatLoad,
  formatPercent,
  formatTemperature,
  levelFor,
} from '../format';
import type {StatusSnapshot} from '../types';

const {palette, space, type} = tokens;

export function HardwareSection({data}: {data: StatusSnapshot}) {
  const {color: accent} = useAccent();
  const {cpu, memory, storage, system, unsupported} = data;
  const frequency = cpu?.frequency;
  const swap = memory?.swap;

  return (
    <View style={styles.wrap}>
      <SectionCard title="Processor" testID="status-cpu">
        {cpu ? (
          <>
            <Text style={type.title}>{cpu.model ?? 'Unknown processor'}</Text>
            <Text style={type.caption}>
              {[cpu.physical_cores ? `${cpu.physical_cores} cores` : null, cpu.logical_cores ? `${cpu.logical_cores} threads` : null]
                .filter(Boolean)
                .join(' · ') || MISSING}
            </Text>
            <View style={styles.headline}>
              <Text style={styles.big}>{formatPercent(cpu.percent)}</Text>
              <Text style={type.caption}>in use</Text>
            </View>
            <Meter value={cpu.percent} level={levelFor(cpu.percent, LIMITS.cpu)} label="CPU usage" />
            {cpu.per_core && cpu.per_core.length > 0 && (
              <View style={styles.block}>
                <Text style={type.caption}>Per thread</Text>
                <CoreBars values={cpu.per_core} color={accent} />
              </View>
            )}
            <Row
              label="Frequency"
              value={frequency?.current_mhz ? formatFrequency(frequency.current_mhz) : MISSING}
              note={
                frequency?.base_mhz
                  ? `base ${formatFrequency(frequency.base_mhz)}`
                  : frequency?.max_mhz
                    ? `max ${formatFrequency(frequency.max_mhz)}`
                    : unsupported['cpu.frequency']
              }
            />
            <Row
              label="Load"
              value={cpu.load ? `${formatLoad(cpu.load['1m'])} · ${formatLoad(cpu.load['5m'])} · ${formatLoad(cpu.load['15m'])}` : MISSING}
              note={cpu.load ? '1, 5 and 15 minute averages' : unsupported['cpu.load'] ?? 'Not available'}
            />
            <Row
              label="Temperature"
              value={cpu.temperature ? formatTemperature(cpu.temperature.current) : MISSING}
              note={cpu.temperature ? null : unsupported['cpu.temperature'] ?? 'Not available'}
            />
            {cpu.temperature?.sensors.map(sensor => (
              <Row key={sensor.label} label={sensor.label} value={formatTemperature(sensor.celsius)} />
            ))}
          </>
        ) : (
          <Unsupported reason={unsupported['cpu.percent']} />
        )}
      </SectionCard>

      <SectionCard title="Memory" testID="status-memory">
        {memory ? (
          <>
            <View style={styles.headline}>
              <Text style={styles.big}>{formatPercent(memory.percent)}</Text>
              <Text style={type.caption}>{`${formatBytes(memory.used)} of ${formatBytes(memory.total)}`}</Text>
            </View>
            <Meter value={memory.percent} level={levelFor(memory.percent, LIMITS.memory)} label="Memory usage" />
            <Row label="Available" value={formatBytes(memory.available)} />
            {swap && swap.total > 0 ? (
              <View style={styles.block}>
                <Row label="Swap" value={`${formatBytes(swap.used)} of ${formatBytes(swap.total)}`} note={formatPercent(swap.percent)} />
                <Meter value={swap.percent} level={levelFor(swap.percent, LIMITS.swap)} label="Swap usage" />
              </View>
            ) : (
              <Row label="Swap" value="None configured" />
            )}
          </>
        ) : (
          <Unsupported reason={unsupported.memory} />
        )}
      </SectionCard>

      <SectionCard title="Storage" testID="status-storage">
        {storage?.stale && <Text style={[type.caption, styles.warn]}>These figures are out of date: a drive is not answering.</Text>}
        {storage && storage.partitions.length > 0 ? (
          storage.partitions.map(partition => (
            <View key={partition.mount} style={styles.block}>
              <View style={styles.partitionHead}>
                <Text style={[type.label, styles.flex]} numberOfLines={1}>
                  {partition.label ? `${partition.mount}  ${partition.label}` : partition.mount}
                </Text>
                <Text style={type.caption}>{formatPercent(partition.percent)}</Text>
              </View>
              <Meter value={partition.percent} level={levelFor(partition.percent, LIMITS.storage)} label={`${partition.mount} usage`} />
              <Text style={type.caption}>
                {`${formatBytes(partition.free)} free of ${formatBytes(partition.total)} · ${[partition.fs, partition.kind].filter(Boolean).join(' · ')}`}
              </Text>
            </View>
          ))
        ) : (
          <Unsupported reason={unsupported.storage} />
        )}
      </SectionCard>

      <SectionCard title="Disk activity" testID="status-io">
        {storage?.io ? (
          <>
            <Row label="Read" value={formatByteRate(storage.io.read_bps)} />
            <Row label="Write" value={formatByteRate(storage.io.write_bps)} />
            {storage.io.disks.map(disk => (
              <Row
                key={disk.name}
                label={disk.volumes ? `${disk.name} (${disk.volumes})` : disk.name}
                value={`${formatByteRate(disk.read_bps)} read · ${formatByteRate(disk.write_bps)} write`}
                note={disk.busy_percent !== null ? `${formatPercent(disk.busy_percent)} busy` : null}
              />
            ))}
          </>
        ) : (
          <Unsupported reason={unsupported['storage.io']} />
        )}
      </SectionCard>

      <SectionCard title="System" testID="status-system">
        <Row label="Operating system" value={system?.os ?? MISSING} note={system?.kernel ? `kernel ${system.kernel}` : null} />
        <Row label="Hardware" value={[system?.vendor, system?.model].filter(Boolean).join(' ') || MISSING} />
        <Row label="Architecture" value={system?.architecture ?? MISSING} />
        <Row label="Host name" value={system?.hostname ?? MISSING} />
        <Row label="Up for" value={formatDuration(system?.uptime_seconds)} />
        <Row label="Python" value={system?.python ?? MISSING} />
      </SectionCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: space.md},
  headline: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
  big: {...type.display, fontSize: 34, lineHeight: 40},
  block: {gap: space.sm},
  partitionHead: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  flex: {flex: 1},
  warn: {color: palette.warn},
});
