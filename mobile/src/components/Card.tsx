import React from 'react';
import {StyleSheet, View, ViewProps} from 'react-native';
import {colors, radius, spacing} from '../theme';

/** StarCore's flat card surface, the same as Surface but with the older spacing scale. */
export function Card({style, ...props}: ViewProps) {
  return <View style={[styles.card, style]} {...props} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
});
