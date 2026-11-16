import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../theme';
import {SettingsButton} from '../components/SettingsButton';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {PhotoAlbumsTab} from './PhotoAlbumsTab';
import {PhotoLibraryTab} from './PhotoLibraryTab';
import {PhotoMapTab} from './PhotoMapTab';
import {PhotoSearchTab} from './PhotoSearchTab';
import type {AlbumSummary, Photo} from './types';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoHome'>;

// Photo's settings are reached through the gear icon below, not a segment.
// The Recycle bin is reached from inside the Albums section, same as the web
// panel's own Albums tab.
type Section = 'library' | 'albums' | 'map' | 'search';
const SECTIONS: {key: Section; label: string}[] = [
  {key: 'library', label: 'Library'},
  {key: 'albums', label: 'Albums'},
  {key: 'map', label: 'Map'},
  {key: 'search', label: 'Search'},
];

/**
 * The Photo satellite's dedicated mobile home - Library / Albums / Map /
 * Search as one screen with a segmented control rather than four separate
 * stack screens, so switching between them never re-triggers navigation
 * transitions. Photo's ui.json is its default interface; this is the
 * previous screen, kept in Developer Mode until it is retired
 * (docs/remaining-work.md).
 */
export function PhotoHomeScreen({navigation, route}: Props) {
  const accentStyle = useAccentStyles();
  // a section opened by name (the own action) shows the segment of that name, anything else the library
  const opened = SECTIONS.find(item => item.key === route.params?.section)?.key;
  const [section, setSection] = useState<Section>(opened ?? 'library');

  const openPhoto = (photos: Photo[], index: number) => {
    navigation.navigate('PhotoViewer', {
      media: photos.map(photo => ({id: photo.id, mediaType: photo.media_type, duration: photo.duration})),
      startIndex: index,
    });
  };

  const openAlbum = (album: AlbumSummary) => {
    navigation.navigate('PhotoAlbum', {albumId: album.id, name: album.name});
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={typography.title}>Photos</Text>
          <SettingsButton onPress={() => navigation.navigate('PhotoConfiguration')} label="Photo settings" />
        </View>
        <View style={styles.segments}>
          {SECTIONS.map(item => (
            <Pressable
              key={item.key}
              onPress={() => setSection(item.key)}
              accessibilityRole="tab"
              accessibilityState={{selected: section === item.key}}
              accessibilityLabel={item.label}
              style={[styles.segment, section === item.key && accentStyle.fill]}>
              <Text style={[typography.body, styles.segmentLabel, section === item.key && [styles.segmentLabelActive, accentStyle.onFill]]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {section === 'library' && <PhotoLibraryTab onOpenPhoto={openPhoto} />}
      {section === 'albums' && (
        <PhotoAlbumsTab onOpenAlbum={openAlbum} onOpenTrash={() => navigation.navigate('PhotoTrash')} />
      )}
      {section === 'map' && <PhotoMapTab onOpenPhoto={openPhoto} />}
      {section === 'search' && <PhotoSearchTab onOpenPhoto={openPhoto} onOpenAlbum={openAlbum} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  header: {padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.md},
  titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  segments: {flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 10, padding: 3, gap: 3},
  segment: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  segmentLabel: {color: colors.textDim, fontSize: 14},
  segmentLabelActive: {color: colors.onSelected, fontWeight: '700'},
});
