import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useServers} from '../servers/ServersContext';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography} from '../theme';
import type {SettingsStackParamList} from '../navigation/MainTabs';

type Props = NativeStackScreenProps<SettingsStackParamList, 'Servers'>;

/**
 * "Manage servers" - add, switch between and remove the StarCore servers
 * this device knows about (see "Multiple StarCore servers" in the task
 * brief). Reached from Settings, not Config: which server is active is a
 * property of this app, not of any one server.
 */
export function ServersScreen({navigation}: Props) {
  const {servers, activeServer, switchTo, remove} = useServers();

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
            <Card style={styles.card}>
              <Pressable onPress={() => !isActive && switchTo(item.id)} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={typography.heading}>{item.name}</Text>
                  <Text style={typography.caption}>{item.baseUrl}</Text>
                </View>
                {isActive && <Text style={styles.active}>ACTIVE</Text>}
              </Pressable>
              <PrimaryButton title="Remove" variant="secondary" onPress={() => confirmRemove(item.id, item.name)} />
            </Card>
          );
        }}
        ListHeaderComponent={<Text style={typography.title}>Servers</Text>}
        ListFooterComponent={
          <PrimaryButton title="Add server" onPress={() => navigation.navigate('AddServer')} />
        }
        ListFooterComponentStyle={styles.footer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {padding: spacing.lg, gap: spacing.md},
  card: {gap: spacing.sm},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  rowText: {gap: spacing.xs},
  active: {color: colors.ok, fontSize: 12, fontWeight: '600'},
  footer: {marginTop: spacing.sm},
});
