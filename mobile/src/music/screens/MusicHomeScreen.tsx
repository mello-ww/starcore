import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography} from '../../theme';
import {PillTabs} from '../../components/PillTabs';
import {SettingsButton} from '../../components/SettingsButton';
import {useMusicNavigation} from '../ui/navigation';
import {HomeTab} from './HomeTab';
import {LibraryTab} from './LibraryTab';
import {SearchTab} from './SearchTab';

type Section = 'home' | 'search' | 'library';
const SECTIONS: {key: Section; label: string}[] = [
  {key: 'home', label: 'Home'},
  {key: 'search', label: 'Search'},
  {key: 'library', label: 'Your Library'},
];

/** Music's own home, opened from the Satellites list like Photo's: Home, Search and Library. */
export function MusicHomeScreen() {
  const [section, setSection] = useState<Section>('home');
  const go = useMusicNavigation();
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={typography.title}>Music</Text>
        <SettingsButton onPress={go.settings} label="Music settings" />
      </View>
      <View style={styles.segments}>
        <PillTabs items={SECTIONS} selected={section} onSelect={setSection} testIDPrefix="music-section" />
      </View>
      <View style={styles.body}>
        {section === 'home' && <HomeTab />}
        {section === 'search' && <SearchTab />}
        {section === 'library' && <LibraryTab />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.md},
  segments: {marginHorizontal: spacing.md, marginTop: spacing.md},
  body: {flex: 1},
});
