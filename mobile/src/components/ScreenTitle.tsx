import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {DeveloperModeButton} from '../developer/DeveloperModeButton';
import {tokens} from '../theme';

/** A tab's own heading: a spaced eyebrow above a large title, as on Home. A tab passes
 * `developerToggle` to put the Developer Mode switch at its top right. */
export function ScreenTitle({
  eyebrow,
  title,
  subtitle,
  developerToggle = false,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  developerToggle?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.top}>
        <Text style={[tokens.type.eyebrow, styles.eyebrow]}>{eyebrow.toUpperCase()}</Text>
        {developerToggle ? (
          <View style={styles.toggle}>
            <DeveloperModeButton />
          </View>
        ) : null}
      </View>
      <Text style={tokens.type.display}>{title}</Text>
      {subtitle ? <Text style={tokens.type.body}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {gap: tokens.space.sm, marginBottom: tokens.space.sm},
  top: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 20},
  eyebrow: {flex: 1},
  // the 44pt touch target overlaps the spacing around the eyebrow instead of pushing the title down
  toggle: {marginVertical: -12},
});
