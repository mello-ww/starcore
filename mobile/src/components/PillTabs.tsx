import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text} from 'react-native';
import {tokens, useAccent} from '../theme';
import {useSlidingSelection} from './motion';

const {palette, space, type} = tokens;

/** A row of pill tabs: the selected one is filled with the accent, which slides from tab to
 * tab (useSlidingSelection). Any screen with a few sections can use it. */
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
  const {onColor: onAccent} = useAccent();
  const {indicator, onItemLayout, selectedBackground} = useSlidingSelection(items.findIndex(item => item.key === selected), {
    track: palette.control,
  });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {indicator}
      {items.map((item, index) => {
        const active = item.key === selected;
        return (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item.key)}
            accessibilityRole="tab"
            accessibilityState={{selected: active}}
            testID={`${testIDPrefix}-${item.key}`}
            onLayout={onItemLayout(index)}
            style={({pressed}) => [styles.tab, selectedBackground(active, index), pressed && !active && styles.pressed]}>
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
