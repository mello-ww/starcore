import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useServers} from '../servers/ServersContext';
import {Button} from '../components/Button';
import {Surface} from '../components/Surface';
import {tokens, useAccent} from '../theme';
import type {SettingsStackParamList} from '../navigation/MainTabs';

const {palette, space, type} = tokens;

type Props = NativeStackScreenProps<SettingsStackParamList, 'Servers'>;

/**
 * "Manage servers" - add, switch between and remove the StarCore servers
 * this device knows about (see "Multiple StarCore servers" in the task
 * brief). Reached from Settings, not Config: which server is active is a
 * property of this app, not of any one server.
 */
export function ServersScreen({navigation}: Props) {
  const {servers, activeServer, switchTo, remove} = useServers();
  const {color: accent} = useAccent();

  const confirmRemove = (id: string, name: string) => {
    Alert.alert(`Remove "${name}"?`, 'This only forgets it on this device - the server itself is unaffected.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Remove', style: 'destructive', onPress: () => remove(id)},
    ]);
  };

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={styles.content}
        data={servers}
        keyExtractor={item => item.id}
        renderItem={({item}) => {
          const isActive = item.id === activeServer?.id;
          return (
            <Surface style={styles.card}>
              <Pressable
                onPress={() => !isActive && switchTo(item.id)}
                accessibilityRole="button"
                accessibilityLabel={isActive ? `${item.name}, active` : `Switch to ${item.name}`}
                style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={type.title}>{item.name}</Text>
                  <Text style={type.caption}>{item.baseUrl}</Text>
                </View>
                {isActive && <Text style={[type.meta, {color: accent}]}>ACTIVE</Text>}
              </Pressable>
              <Button
                title="Remove"
                variant="danger"
                style={styles.remove}
                onPress={() => confirmRemove(item.id, item.name)}
              />
            </Surface>
          );
        }}
        ListFooterComponent={<Button title="Add server" onPress={() => navigation.navigate('AddServer')} />}
        ListFooterComponentStyle={styles.footer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  content: {padding: space.lg, gap: space.md},
  card: {gap: space.md},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48},
  rowText: {flex: 1, gap: space.xs},
  remove: {alignSelf: 'flex-start'},
  footer: {marginTop: space.sm},
});
