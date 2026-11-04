import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text} from 'react-native';
import {tokens, useAccent} from '../theme';

const {palette, space, type} = tokens;

/** A row of pill tabs, as on Status: the selected one is filled with the accent. Any screen
 * with a few sections can use it (Music today; Photos and File Explorer later). */
export function PillTabs<K extends string>({
  items,
  selected,
  onSelect,
  testIDPrefix = 'pill-tab',
}: {
  items: readonly {key: K; label: string}[];
  selected: K;
  onSelect: (key: K) => void;
  testIDPrefix?: string;
}) {
  const {color: accent, onColor: onAccent} = useAccent();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {items.map(item => {
        const active = item.key === selected;
        return (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item.key)}
            accessibilityRole="tab"
            accessibilityState={{selected: active}}
            testID={`${testIDPrefix}-${item.key}`}
            style={({pressed}) => [styles.tab, active && {backgroundColor: accent}, pressed && !active && styles.pressed]}>
            <Text style={[styles.label, active && {color: onAccent}]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {gap: space.sm},
  tab: {minHeight: 36, paddingHorizontal: 14, borderRadius: 999, backgroundColor: palette.control, alignItems: 'center', justifyContent: 'center'},
  pressed: {backgroundColor: palette.controlStrong},
  label: {...type.caption, color: palette.text2, fontWeight: '600'},
});
