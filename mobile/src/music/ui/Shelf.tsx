import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {spacing, typography, useAccentStyles} from '../../theme';
import {Artwork, Mosaic} from '../../media/ui/Artwork';

export interface ShelfItem {
  key: string;
  title: string;
  subtitle?: string;
  albumId?: string | null;
  mosaic?: string[];
  round?: boolean;
  onPress: () => void;
}

const SIZE = 132;

export function Shelf({title, subtitle, items}: {title: string; subtitle?: string | null; items: ShelfItem[]}) {
  if (!items.length) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={typography.heading}>{title}</Text>
      {!!subtitle && <Text style={typography.caption}>{subtitle}</Text>}
      <FlatList
        horizontal
        data={items}
        keyExtractor={item => item.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        renderItem={({item}) => (
          <Pressable onPress={item.onPress} style={styles.card} accessibilityRole="button" accessibilityLabel={item.title}>
            {item.mosaic ? (
              <Mosaic albums={item.mosaic} size={SIZE} label={item.title} />
            ) : (
              <Artwork albumId={item.albumId} size={SIZE} round={item.round} label={item.title} />
            )}
            <Text numberOfLines={1} style={[typography.body, styles.title, item.round && styles.center]}>
              {item.title}
            </Text>
            {!!item.subtitle && (
              <Text numberOfLines={1} style={[typography.caption, item.round && styles.center]}>
                {item.subtitle}
              </Text>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

export function SectionHeader({title, action, onAction}: {title: string; action?: string; onAction?: () => void}) {
  const accentStyle = useAccentStyles();
  return (
    <View style={styles.header}>
      <Text style={typography.heading}>{title}</Text>
      {action && (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={accentStyle.text}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {marginTop: spacing.lg},
  row: {gap: spacing.md, paddingTop: spacing.sm},
  card: {width: SIZE},
  title: {marginTop: spacing.xs, fontSize: 14},
  center: {textAlign: 'center'},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.lg},
});
