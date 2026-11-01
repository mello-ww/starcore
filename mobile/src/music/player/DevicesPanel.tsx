import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../../theme';
import {useMusic, usePlayerState} from '../MusicProvider';
import type {ConnectDevice} from '../types';

/** StarCore Connect: move playback between this phone and the listener's other devices. */
export function DevicesPanel() {
  const {api, player, deviceId} = useMusic();
  const state = usePlayerState();
  const [devices, setDevices] = useState<ConnectDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.devices().then(result => {
      setDevices(result.devices);
      setError(null);
    }).catch((failure: any) => setError(failure?.message ?? 'Could not load devices.'));

  useEffect(() => {
    load();
  }, []);

  const select = async (device: ConnectDevice) => {
    if (!deviceId) {
      return;
    }
    try {
      if (device.id === deviceId) {
        const remote = state.remote;
        if (remote) {
          await api.transfer(deviceId, deviceId);
          player.setRemote(null);
        }
        return;
      }
      if (state.track && !state.remote) {
        player.persist(true);
        await new Promise<void>(resolve => setTimeout(() => resolve(), 300));
        await api.transfer(deviceId, device.id, state.playing);
        player.pause();
      }
      player.setRemote({device: device.id, name: device.name, state: {playing: true}});
    } catch (failure: any) {
      setError(failure?.message ?? 'That device did not respond.');
    }
    load();
  };

  return (
    <ScrollView>
      <Text style={typography.heading}>Play on</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {(devices ?? []).map(device => {
        const current = state.remote ? state.remote.device === device.id : device.id === deviceId;
        return (
          <Pressable key={device.id} onPress={() => select(device)} disabled={!device.online && device.id !== deviceId}
            style={[styles.device, !device.online && styles.offline]}>
            <Text style={styles.icon}>{device.kind === 'web' ? '🖥' : device.kind === 'mobile' ? '📱' : '🔊'}</Text>
            <View style={styles.text}>
              <Text style={[typography.body, current && styles.current]}>
                {device.name}{device.id === deviceId ? ' (this phone)' : ''}
              </Text>
              <Text style={typography.caption}>
                {device.online ? (device.playing ? 'Playing' : 'Available') : 'Offline'}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <Text style={[typography.caption, styles.note]}>
        Music streams straight from your server to the device that plays it. This phone answers remote control
        while the app is open; Android pauses that in the background.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  error: {color: colors.alert, marginVertical: spacing.sm},
  device: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md},
  offline: {opacity: 0.5},
  icon: {fontSize: 22},
  text: {flex: 1},
  current: {color: colors.azure, fontWeight: '600'},
  note: {marginTop: spacing.md},
});
