import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {PhotoFoldersTab} from './PhotoFoldersTab';
import {PhotoLibraryTab} from './PhotoLibraryTab';
import {PhotoSearchTab} from './PhotoSearchTab';
import {PhotoSyncTab} from './PhotoSyncTab';
import {PhotoTrashTab} from './PhotoTrashTab';
import type {AlbumSummary, Photo} from './types';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoHome'>;

type Section = 'library' | 'folders' | 'search' | 'trash' | 'sync';
const SECTIONS: {key: Section; label: string}[] = [
  {key: 'library', label: 'Library'},
  {key: 'folders', label: 'Folders'},
  {key: 'search', label: 'Search'},
  {key: 'trash', label: 'Bin'},
  {key: 'sync', label: 'Sync'},
];

/**
 * The Photo satellite's dedicated mobile home - the three sections the task
 * brief calls for (Library / Folders / Search), as one screen with a
 * segmented control rather than three separate stack screens, so switching
 * between them never re-triggers navigation transitions. This is what
 * SatellitesListScreen opens for "Photo" instead of the generic
 * SatelliteDetail + DeclarativeScreen every other Satellite gets - see
 * "Exposing a mobile interface" in docs/satellites.md for why Photo still
 * also answers a plain declarative "mobile" route for any *other* client.
 */
export function PhotoHomeScreen({navigation}: Props) {
  const [section, setSection] = useState<Section>('library');

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
        <Text style={typography.title}>Photos</Text>
        <View style={styles.segments}>
          {SECTIONS.map(item => (
            <Pressable
              key={item.key}
              onPress={() => setSection(item.key)}
              style={[styles.segment, section === item.key && styles.segmentActive]}>
              <Text style={[typography.body, styles.segmentLabel, section === item.key && styles.segmentLabelActive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {section === 'library' && <PhotoLibraryTab onOpenPhoto={openPhoto} />}
      {section === 'folders' && <PhotoFoldersTab onOpenAlbum={openAlbum} />}
      {section === 'search' && <PhotoSearchTab onOpenPhoto={openPhoto} onOpenAlbum={openAlbum} />}
      {section === 'trash' && <PhotoTrashTab />}
      {section === 'sync' && <PhotoSyncTab />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  header: {padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.md},
  segments: {flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 10, padding: 3, gap: 3},
  segment: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center'},
  segmentActive: {backgroundColor: colors.raised},
  segmentLabel: {color: colors.textDim, fontSize: 14},
  segmentLabelActive: {color: colors.text, fontWeight: '600'},
});
