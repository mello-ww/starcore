import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
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
  const accentStyle = useAccentStyles();
  const [section, setSection] = useState<Section>('home');
  const go = useMusicNavigation();
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={typography.title}>Music</Text>
        <SettingsButton onPress={go.settings} label="Music settings" />
      </View>
      <View style={styles.segments}>
        {SECTIONS.map(item => (
          <Pressable key={item.key} onPress={() => setSection(item.key)} style={[styles.segment, section === item.key && accentStyle.fill]}
            accessibilityRole="tab" accessibilityState={{selected: section === item.key}}>
            <Text style={[styles.segmentLabel, section === item.key && styles.segmentLabelActive]}>{item.label}</Text>
          </Pressable>
        ))}
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
  segments: {flexDirection: 'row', marginHorizontal: spacing.md, marginTop: spacing.md, borderRadius: 18, backgroundColor: colors.raised, padding: 3},
  segment: {flex: 1, paddingVertical: 7, borderRadius: 16, alignItems: 'center'},
  segmentLabel: {color: colors.textDim, fontSize: 14},
  segmentLabelActive: {color: colors.onSelected, fontWeight: '700'},
  body: {flex: 1},
});
