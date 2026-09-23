import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Card} from '../components/Card';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

/**
 * The dashboard tab - foundation only for this block. A later block wires
 * this up to `GET /api/status` and satellite summaries (mirroring Mission
 * Control's own dashboard), the same way Locked Folder/File
 * Explorer/Photos will fill in their own placeholder tabs.
 */
export function HomeScreen() {
  return (
    <View style={styles.screen}>
      <Starfield />
      <View style={styles.content}>
        <Text style={typography.title}>StarCore</Text>
        <Card style={styles.card}>
          <Text style={typography.heading}>Connected</Text>
          <Text style={[typography.caption, styles.caption]}>
            You're signed in. Satellite status and quick actions land here in a later update.
          </Text>
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  card: {gap: spacing.xs},
  caption: {marginTop: spacing.xs},
});
