import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {tokens} from '../theme';

/** A tab's own heading: a spaced eyebrow above a large title, as on Home. */
export function ScreenTitle({eyebrow, title, subtitle}: {eyebrow: string; title: string; subtitle?: string}) {
  return (
    <View style={styles.wrap}>
      <Text style={tokens.type.eyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={tokens.type.display}>{title}</Text>
      {subtitle ? <Text style={tokens.type.body}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: tokens.space.sm, marginBottom: tokens.space.sm},
});
