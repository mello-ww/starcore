import React from 'react';
import {StyleSheet, View, ViewProps} from 'react-native';
import {tokens} from '../theme';

/** The StarCore card surface: flat, rounded, no border. */
export function Surface({style, ...props}: ViewProps) {
  return <View style={[styles.surface, style]} {...props} />;
}

const styles = StyleSheet.create({
  surface: {
    padding: tokens.space.lg,
    borderRadius: tokens.radii.card,
    backgroundColor: tokens.palette.card,
  },
});
