import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {useServers} from '../servers/ServersContext';
import {colors, spacing, typography} from '../theme';

/**
 * The first screen of every cold start once at least one server is known:
 * pick which StarCore to open. Nothing server-specific (session, data,
 * even the biometric lock screen) is created before a server is chosen -
 * see App.tsx's ServersGate, which only mounts AuthProvider for the
 * selected server. The server used last time is highlighted, never opened
 * automatically.
 *
 * Android hardware back on this screen leaves the app; it is the root.
 */
export function ServerListScreen({onAdd}: {onAdd: () => void}) {
  const {servers, lastServerId, switchTo} = useServers();

  return (
    <View style={styles.screen} testID="server-list-screen">
      <FlatList
        contentContainerStyle={styles.content}
        data={servers}
        keyExtractor={item => item.id}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={typography.title}>StarCore</Text>
            <Text style={[typography.caption, styles.subtitle]}>Choose a server to open.</Text>
          </View>
        }
        renderItem={({item}) => (
          <Pressable onPress={() => switchTo(item.id)} testID={`server-row-${item.id}`}>
            <Card style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={typography.heading}>{item.name}</Text>
                  <Text style={typography.caption}>{item.baseUrl}</Text>
                </View>
                {item.id === lastServerId && <Text style={styles.last}>LAST USED</Text>}
                <Text style={styles.chevron}>›</Text>
              </View>
            </Card>
          </Pressable>
        )}
        ListFooterComponent={<PrimaryButton title="Add server" variant="secondary" onPress={onAdd} />}
        ListFooterComponentStyle={styles.footer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  header: {marginBottom: spacing.md},
  subtitle: {marginTop: spacing.xs},
  card: {},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  rowText: {flex: 1, gap: spacing.xs},
  last: {color: colors.ok, fontSize: 12, fontWeight: '600'},
  chevron: {color: colors.textFaint, fontSize: 20},
  footer: {marginTop: spacing.sm},
});
