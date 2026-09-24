import React, {useMemo} from 'react';
import {Dimensions, RefreshControl, SectionList, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../theme';
import type {Photo} from './types';
import {PhotoThumbnail} from './PhotoThumbnail';

const COLUMNS = 3;
const GUTTER = spacing.md * 2;

/** captured_at/imported_at is an ISO timestamp; the group only ever needs
 * the calendar date out of it, in whatever order the server already sorted
 * (newest first) - never re-sorted or re-interpreted here. */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return date.toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

interface Section {
  title: string;
  data: Photo[][];
}

/** Groups already-sorted photos into date sections, then chunks each
 * section into fixed-width rows - SectionList has no numColumns of its own,
 * so each "item" it renders is actually one row of up to COLUMNS photos.
 * `groupByDate: false` (Folders, Search) still uses the same row-chunking,
 * just under a single untitled section. */
export function toSections(photos: Photo[], groupByDate: boolean): Section[] {
  if (!groupByDate) {
    return [{title: '', data: chunk(photos, COLUMNS)}];
  }

  const sections: Section[] = [];
  let currentLabel: string | null = null;
  let current: Photo[] = [];

  for (const photo of photos) {
    const label = dateLabel(photo.captured_at || photo.imported_at);
    if (label !== currentLabel) {
      if (current.length) {
        sections.push({title: currentLabel!, data: chunk(current, COLUMNS)});
      }
      currentLabel = label;
      current = [];
    }
    current.push(photo);
  }
  if (current.length) {
    sections.push({title: currentLabel!, data: chunk(current, COLUMNS)});
  }
  return sections;
}

interface Props {
  photos: Photo[];
  trashed?: boolean;
  groupByDate?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onPressPhoto: (photo: Photo, index: number) => void;
  onLongPressPhoto?: (photo: Photo) => void;
  selectedIds?: Set<string>;
  emptyMessage: string;
}

export function PhotoGrid({
  photos,
  trashed,
  groupByDate = false,
  refreshing,
  onRefresh,
  onPressPhoto,
  onLongPressPhoto,
  selectedIds,
  emptyMessage,
}: Props) {
  const sections = useMemo(() => toSections(photos, groupByDate), [photos, groupByDate]);
  const cellSize = (Dimensions.get('window').width - GUTTER) / COLUMNS;

  if (photos.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={typography.caption}>{emptyMessage}</Text>
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(row, index) => `${row[0]?.id ?? 'row'}-${index}`}
      contentContainerStyle={styles.content}
      renderSectionHeader={({section}) =>
        section.title ? <Text style={[typography.label, styles.sectionHeader]}>{section.title}</Text> : null
      }
      renderItem={({item: row, index: rowIndex, section}) => {
        const sectionStart = section.data.slice(0, rowIndex).reduce((sum, r) => sum + r.length, 0);
        return (
          <View style={styles.row}>
            {row.map((photo, columnIndex) => (
              <PhotoThumbnail
                key={photo.id}
                photoId={photo.id}
                trashed={trashed}
                size={cellSize}
                isVideo={photo.media_type === 'video'}
                duration={photo.duration}
                selected={selectedIds ? selectedIds.has(photo.id) : undefined}
                onPress={() => onPressPhoto(photo, sectionStart + columnIndex)}
                onLongPress={onLongPressPhoto ? () => onLongPressPhoto(photo) : undefined}
              />
            ))}
          </View>
        );
      }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.azure} /> : undefined
      }
      stickySectionHeadersEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: spacing.xl},
  sectionHeader: {paddingTop: spacing.md, paddingBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.4},
  row: {flexDirection: 'row'},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl},
});
