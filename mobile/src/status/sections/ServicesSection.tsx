import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {STATUS_LABELS, statusDotColor} from '../../satellites/icons';
import {tokens} from '../../theme';
import {Dot, Row, SectionCard} from '../components';
import {formatDuration} from '../format';
import type {StatusSnapshot} from '../types';

const {palette, space, type} = tokens;

export function ServicesSection({data}: {data: StatusSnapshot}) {
  const {engine, satellites, dependencies, components, online, total} = data.services;
  return (
    <View style={styles.wrap}>
      <SectionCard title="Engine" testID="status-engine">
        <View style={styles.head}>
          <Dot color={engine.running ? palette.textIcon : palette.danger} />
          <Text style={type.title}>{`${engine.name} is ${engine.running ? 'running' : 'stopped'}`}</Text>
        </View>
        <Row label="Up for" value={formatDuration(engine.uptime_seconds)} />
        <Row
          label="Mission Control"
          value={!engine.mission_control.enabled ? 'Turned off' : engine.mission_control.running ? 'Running' : 'Not running'}
        />
        <Row label="Satellite services" value={engine.satellite_services ? 'On' : 'Off'} />
        <Row label="Commands" value={String(engine.commands)} />
      </SectionCard>

      <SectionCard title={`Satellites · ${online} of ${total} online`} testID="status-satellites">
        {satellites.map(satellite => (
          <View key={satellite.name} style={styles.satellite}>
            <View style={styles.head}>
              <Dot color={statusDotColor(satellite.status)} size={7} />
              <Text style={[type.label, styles.flex]}>{satellite.name}</Text>
              <Text style={type.caption}>{STATUS_LABELS[satellite.status] ?? satellite.status}</Text>
            </View>
            <Text style={[type.caption, styles.muted]}>
              {[`v${satellite.version}`, satellite.type, satellite.service ? 'background service' : 'no background service']
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {satellite.last_error ? <Text style={[type.caption, styles.error]}>{satellite.last_error}</Text> : null}
          </View>
        ))}
      </SectionCard>

      {dependencies.length > 0 && (
        <SectionCard title="Depends on">
          {dependencies.map(item => (
            <Row
              key={`${item.satellite}-${item.needs}`}
              label={item.satellite}
              value={item.kind === 'section' ? `Part of ${item.needs}` : item.needs}
            />
          ))}
        </SectionCard>
      )}

      <SectionCard title="Optional components" testID="status-components">
        {components.map(item => (
          <View key={item.name} style={styles.satellite}>
            <View style={styles.head}>
              <Dot color={item.available ? palette.textIcon : palette.text3} size={7} />
              <Text style={[type.label, styles.flex]}>{item.name}</Text>
              <Text style={type.caption}>{item.available ? 'Installed' : 'Not installed'}</Text>
            </View>
            <Text style={[type.caption, styles.muted]}>{item.used_for}</Text>
          </View>
        ))}
      </SectionCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: space.md},
  head: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  satellite: {gap: 2},
  flex: {flex: 1},
  muted: {color: palette.text3},
  error: {color: palette.danger},
});
