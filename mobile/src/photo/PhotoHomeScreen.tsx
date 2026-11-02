import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {colors, spacing, typography, useAccentStyles} from '../theme';
import {SettingsButton} from '../components/SettingsButton';
import {useLockedFolder} from '../lockedFolder/useLockedFolder';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {LockedFolderTab} from './LockedFolderTab';
import {PhotoAlbumsTab} from './PhotoAlbumsTab';
import {PhotoLibraryTab} from './PhotoLibraryTab';
import {PhotoMapTab} from './PhotoMapTab';
import {PhotoSearchTab} from './PhotoSearchTab';
import type {AlbumSummary, Photo} from './types';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoHome'>;

// "Sync" is deliberately not a section of its own any more - phone sync's
// enable/Wi-Fi-only/Sync-now/status all live inside Photo configuration
// now, reached via the gear icon below, not a segment (see "reorganize
// mobile Photos navigation" in the task brief). The Recycle bin is reached
// from inside the Albums section, same as the web panel's own Albums tab.
type Section = 'library' | 'albums' | 'map' | 'search' | 'locked';
const SECTIONS: {key: Section; label: string}[] = [
  {key: 'library', label: 'Library'},
  {key: 'albums', label: 'Albums'},
  {key: 'map', label: 'Map'},
  {key: 'search', label: 'Search'},
  // shown only when the server has a Locked Folder - see hasLockedFolder
  {key: 'locked', label: 'Locked'},
];

/**
 * The Photo satellite's dedicated mobile home - Library / Albums / Map /
 * Search as one screen with a segmented control rather than four separate
 * stack screens, so switching between them never re-triggers navigation
 * transitions. This is what SatellitesListScreen opens for "Photo" instead
 * of the generic SatelliteDetail + DeclarativeScreen every other Satellite
 * gets - see "Exposing a mobile interface" in docs/satellites.md for why
 * Photo still also answers a plain declarative "mobile" route for any
 * *other* client.
 */
export function PhotoHomeScreen({navigation}: Props) {
  const accentStyle = useAccentStyles();
  const [section, setSection] = useState<Section>('library');
  const {api: lockedApi} = useLockedFolder();
  const [hasLockedFolder, setHasLockedFolder] = useState(false);
  // bumped when photos come back out of the Locked Folder, so Library reloads
  const [libraryKey, setLibraryKey] = useState(0);

  useEffect(() => {
    lockedApi
      .status()
      .then(status => setHasLockedFolder(status !== null))
      .catch(() => setHasLockedFolder(false));
  }, [lockedApi]);

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
          {SECTIONS.filter(item => item.key !== 'locked' || hasLockedFolder).map(item => (
            <Pressable
              key={item.key}
              onPress={() => setSection(item.key)}
              accessibilityRole="tab"
              accessibilityState={{selected: section === item.key}}
              accessibilityLabel={item.key === 'locked' ? 'Locked Folder' : item.label}
              style={[styles.segment, section === item.key && accentStyle.fill]}>
              {item.key === 'locked' ? (
                <Icon
                  name="lock"
                  size={16}
                  style={styles.segmentIcon}
                  color={section === item.key ? styles.segmentLabelActive.color : styles.segmentLabel.color}
                />
              ) : (
                <Text style={[typography.body, styles.segmentLabel, section === item.key && styles.segmentLabelActive]}>
                  {item.label}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>
      {section === 'library' && <PhotoLibraryTab key={libraryKey} onOpenPhoto={openPhoto} />}
      {section === 'albums' && (
        <PhotoAlbumsTab onOpenAlbum={openAlbum} onOpenTrash={() => navigation.navigate('PhotoTrash')} />
      )}
      {section === 'map' && <PhotoMapTab onOpenPhoto={openPhoto} />}
      {section === 'search' && <PhotoSearchTab onOpenPhoto={openPhoto} onOpenAlbum={openAlbum} />}
      {section === 'locked' && hasLockedFolder && <LockedFolderTab onPhotosChanged={() => setLibraryKey(key => key + 1)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  header: {padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.md},
  titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  segments: {flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 10, padding: 3, gap: 3},
  segment: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  segmentIcon: {marginVertical: 2},
  segmentLabel: {color: colors.textDim, fontSize: 14},
  segmentLabelActive: {color: colors.onSelected, fontWeight: '700'},
});
