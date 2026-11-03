import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {tokens, useAccent} from '../../theme';
import {Dot, SectionCard, Tile, Unsupported} from '../components';
import {formatBitRate, formatBytes, formatLinkSpeed} from '../format';
import type {NetworkInterface, StatusSnapshot} from '../types';

const {palette, space, type} = tokens;

const KIND_ICONS: Record<string, string> = {
  ethernet: 'server',
  wifi: 'wifi',
  virtual: 'layers',
  loopback: 'repeat',
};
const KIND_LABELS: Record<string, string> = {
  ethernet: 'Ethernet',
  wifi: 'Wi-Fi',
  virtual: 'Virtual',
  loopback: 'Loopback',
  other: 'Other',
};

export function NetworkSection({data}: {data: StatusSnapshot}) {
  const network = data.network;
  if (!network) {
    return (
      <SectionCard title="Network">
        <Unsupported reason={data.unsupported.network} />
      </SectionCard>
    );
  }
  return (
    <View style={styles.wrap}>
      <View style={styles.tiles}>
        <Tile label="Download" value={formatBitRate(network.rx_bps)} caption="All physical adapters" />
        <Tile label="Upload" value={formatBitRate(network.tx_bps)} caption="All physical adapters" />
      </View>
      <SectionCard title="Interfaces" testID="status-interfaces">
        {network.interfaces.length === 0 && <Text style={type.body}>No network interfaces were reported.</Text>}
        {network.interfaces.map(item => (
          <InterfaceRow key={item.name} item={item} />
        ))}
      </SectionCard>
    </View>
  );
}

function InterfaceRow({item}: {item: NetworkInterface}) {
  const {color: accent} = useAccent();
  const errors = item.rx_errors + item.tx_errors;
  const drops = item.rx_drops + item.tx_drops;
  return (
    <View style={styles.row} accessible accessibilityLabel={`${item.name}, ${item.up ? 'up' : 'down'}`}>
      <Icon name={KIND_ICONS[item.kind] ?? 'globe'} size={18} color={item.up ? accent : palette.text3} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={[type.label, styles.flex]} numberOfLines={1}>
            {item.name}
          </Text>
          <Dot color={item.up ? palette.textIcon : palette.text3} size={6} />
          <Text style={type.caption}>{item.up ? 'Up' : 'Down'}</Text>
        </View>
        <Text style={type.caption}>
          {[KIND_LABELS[item.kind] ?? item.kind, item.speed_mbps ? formatLinkSpeed(item.speed_mbps) : null].filter(Boolean).join(' · ')}
        </Text>
        {item.up && (
          <Text style={type.caption}>{`↓ ${formatBitRate(item.rx_bps)}   ↑ ${formatBitRate(item.tx_bps)}`}</Text>
        )}
        <Text style={[type.caption, styles.muted]}>
          {`${formatBytes(item.rx_bytes)} received · ${formatBytes(item.tx_bytes)} sent`}
        </Text>
        <Text style={[type.caption, errors ? styles.warn : styles.muted]}>
          {errors || drops ? `${errors} errors · ${drops} dropped` : 'No errors'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: space.md},
  tiles: {flexDirection: 'row', flexWrap: 'wrap', gap: space.md},
  row: {flexDirection: 'row', gap: space.md, paddingVertical: space.xs},
  rowBody: {flex: 1, gap: 2},
  rowHead: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  flex: {flex: 1},
  muted: {color: palette.text3},
  warn: {color: palette.warn},
});
