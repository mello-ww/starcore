import React from 'react';
import {StyleSheet, View, ViewProps} from 'react-native';
import {colors, radius, spacing} from '../theme';

/** StarCore's raised, bordered card surface (`.panel` in style.css),
 * touch-adapted: more internal padding and a slightly larger radius than
 * the dense desktop version, since a phone has room for one column, not
 * several side by side. */
export function Card({style, ...props}: ViewProps) {
  return <View style={[styles.card, style]} {...props} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.raised,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
});
