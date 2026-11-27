import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useAudioHost, usePlayerState} from '../AudioHost';
import {upcoming} from '../queue';
import {TrackRow} from './TrackRow';

export function QueuePanel() {
  const accentStyle = useAccentStyles();
  const {player} = useAudioHost();
  const state = usePlayerState();
  const next = upcoming(state.queue);
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={typography.heading}>Next up · {next.length}</Text>
        {next.length > 0 && (
          <Pressable onPress={() => player.clearUpcoming()} hitSlop={8} style={styles.pill}><Text style={accentStyle.text}>Clear</Text></Pressable>
        )}
      </View>
      <FlatList
        data={next}
        keyExtractor={item => `${item.position}-${item.track.id}`}
        ListEmptyComponent={<Text style={typography.caption}>Nothing queued after this song.</Text>}
        renderItem={({item, index}) => (
          <View style={styles.row}>
            <View style={styles.track}>
              <TrackRow track={item.track} onPress={() => player.jumpTo(item.position)} />
            </View>
            <Pressable onPress={() => player.move(item.position, item.position - 1)} disabled={index === 0} hitSlop={6}
              accessibilityLabel="Move up">
              <Icon name="chevron-up" size={20} color={colors.textDim} style={[styles.icon, index === 0 && styles.disabled]} />
            </Pressable>
            <Pressable onPress={() => player.move(item.position, item.position + 1)} disabled={index === next.length - 1}
              hitSlop={6} accessibilityLabel="Move down">
              <Icon name="chevron-down" size={20} color={colors.textDim} style={[styles.icon, index === next.length - 1 && styles.disabled]} />
            </Pressable>
            <Pressable onPress={() => player.removeAt(item.position)} hitSlop={6} accessibilityLabel="Remove from queue">
              <Icon name="x" size={20} color={colors.textDim} style={styles.icon} />
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.raised},
  panel: {flex: 1},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm},
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  track: {flex: 1},
  icon: {padding: 4},
  disabled: {opacity: 0.3},
});
