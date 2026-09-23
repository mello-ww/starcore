import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Card} from '../components/Card';
import {Starfield} from '../components/Starfield';
import {colors, spacing, typography} from '../theme';

/**
 * Shared empty state for every section this foundation block intentionally
 * does not implement yet (File Explorer, Photo Library, Locked Folder) -
 * see "Do NOT attempt to implement every StarCore feature in this block."
 * Each still gets a real tab and a real screen, so the navigation shell and
 * visual language are already in place for the block that fills them in.
 */
export function ComingSoonScreen({title, description}: {title: string; description: string}) {
  return (
    <View style={styles.screen}>
      <Starfield count={20} />
      <View style={styles.content}>
        <Text style={typography.title}>{title}</Text>
        <Card style={styles.card}>
          <Text style={typography.body}>{description}</Text>
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md},
  card: {},
});
