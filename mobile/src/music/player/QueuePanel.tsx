import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic, usePlayerState} from '../MusicProvider';
import {upcoming} from '../queue';
import {TrackRow} from '../ui/TrackRow';

export function QueuePanel() {
  const accentStyle = useAccentStyles();
  const {player} = useMusic();
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
              <Text style={[styles.icon, index === 0 && styles.disabled]}>▲</Text>
            </Pressable>
            <Pressable onPress={() => player.move(item.position, item.position + 1)} disabled={index === next.length - 1}
              hitSlop={6} accessibilityLabel="Move down">
              <Text style={[styles.icon, index === next.length - 1 && styles.disabled]}>▼</Text>
            </Pressable>
            <Pressable onPress={() => player.removeAt(item.position)} hitSlop={6} accessibilityLabel="Remove from queue">
              <Text style={styles.icon}>✕</Text>
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
  icon: {color: colors.textDim, fontSize: 14, padding: 4},
  disabled: {opacity: 0.3},
});
