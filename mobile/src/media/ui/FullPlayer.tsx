import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Modal, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {ModalSafeArea} from '../../components/ModalSafeArea';
import {colors, spacing, touchTarget, typography, useAccent} from '../../theme';
import {useAudioHost, usePlayerState} from '../AudioHost';
import {Artwork} from './Artwork';
import {useAudioAdditions} from './AudioMenu';
import {DevicesPanel} from './DevicesPanel';
import {InfoPanel} from './InfoPanel';
import {LyricsPanel} from './LyricsPanel';
import {QueuePanel} from './QueuePanel';
import {SeekBar} from './SeekBar';

type Panel = 'artwork' | 'lyrics' | 'queue' | 'devices' | 'info';

/** The full-screen player. Android Back and a downward swipe both close it before anything else. */
export function FullPlayer() {
  const {fullPlayer, setFullPlayer} = useAudioHost();
  const state = usePlayerState();
  if (!state.track) {
    return null;
  }
  // the modal is its own window: it takes its insets from a provider inside it (see ModalSafeArea)
  return (
    <Modal visible={fullPlayer} animationType="slide" onRequestClose={() => setFullPlayer(false)} statusBarTranslucent>
      <ModalSafeArea>
        <PlayerBody />
      </ModalSafeArea>
    </Modal>
  );
}

function PlayerBody() {
  const {color: accent, onColor} = useAccent();
  // an active toggle: a soft accent pill behind the accent glyph
  const tint = {backgroundColor: `${accent}29`};
  const {player, setFullPlayer, liked, setLiked, library, connect} = useAudioHost();
  const state = usePlayerState();
  // what the provider's document adds (its `audio`): links and a track menu
  const added = useAudioAdditions();
  const panels = (['lyrics', 'queue', 'devices', 'info'] as Panel[]).filter(
    name => (name !== 'lyrics' || library.offers('lyrics')) && (name !== 'devices' || connect),
  );
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<Panel>('artwork');
  const close = () => setFullPlayer(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 16 && Math.abs(gesture.dx) < 40,
        onPanResponderRelease: (_, gesture) => gesture.dy > 80 && setFullPlayer(false),
      }),
    [setFullPlayer],
  );
  const track = state.track;
  if (!track) {
    return null;
  }
  const remote = state.remote;
  const playing = remote ? !!remote.state?.playing : state.playing;
  const position = remote ? remote.state?.position ?? 0 : state.position;
  const duration = remote ? remote.state?.duration || track.duration || 0 : state.duration;
  const albumLink = added.link('album', track, track.album_id);
  const artistLink = added.link('artist', track, track.artist_id);
  const showMenu = added.hasMenu ? () => added.openMenu(track) : null;

  return (
    <>
      <View style={[styles.screen, {paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.md}]}>
        <View style={styles.top} {...responder.panHandlers}>
          <Pressable onPress={close} style={styles.touch} accessibilityRole="button" accessibilityLabel="Close the player"><Text style={styles.chevron}>⌄</Text></Pressable>
          <Text numberOfLines={1} style={typography.label}>{remote ? `Playing on ${remote.name}` : state.context ?? 'Now playing'}</Text>
          {showMenu ? (
            <Pressable onPress={showMenu} style={styles.touch} accessibilityRole="button" accessibilityLabel="Track options"><Text style={styles.chevron}>⋮</Text></Pressable>
          ) : (
            <View style={styles.touch} />
          )}
        </View>

        <View style={styles.middle} {...(panel === 'artwork' ? responder.panHandlers : {})}>
          {panel === 'artwork' && (
            <View style={styles.artwork}>
              <Artwork albumId={track.has_artwork ? track.album_id : null} size={300} label={track.title} />
            </View>
          )}
          {panel === 'lyrics' && <LyricsPanel trackId={track.id} />}
          {panel === 'queue' && <QueuePanel />}
          {panel === 'devices' && <DevicesPanel />}
          {panel === 'info' && <InfoPanel />}
        </View>

        <View style={styles.titleRow}>
          <View style={styles.titles}>
            <Pressable onPress={albumLink ?? undefined} disabled={!albumLink}>
              <Text numberOfLines={1} style={typography.title}>{track.title}</Text>
            </Pressable>
            <Pressable onPress={artistLink ?? undefined} disabled={!artistLink}>
              <Text numberOfLines={1} style={typography.body}>{track.artist ?? track.album_artist}</Text>
            </Pressable>
            <Text style={typography.label}>
              {track.quality?.hires ? 'Hi-Res' : track.quality?.lossless ? 'Lossless' : track.quality?.label ?? ''}
              {state.source?.local ? ' · Downloaded' : state.plan?.delivery === 'transcode' ? ` · ${state.plan.codec} ${Math.round((state.plan.bitrate ?? 0) / 1000)} kbps` : ''}
            </Text>
          </View>
          <Pressable onPress={() => setLiked([track.id], !liked.has(track.id))} style={styles.touch} accessibilityRole="button" accessibilityLabel="Like">
            <Icon name="heart" size={26} color={liked.has(track.id) ? accent : colors.text} />
          </Pressable>
        </View>

        {state.error && (
          <Pressable onPress={() => player.retry()} style={styles.errorRow}>
            <Text style={styles.error}>{state.error} Tap to retry.</Text>
          </Pressable>
        )}

        <SeekBar position={position} duration={duration} onSeek={seconds => player.seek(seconds)} />

        <View style={styles.controls}>
          <Pressable onPress={() => player.setShuffle(!state.queue.shuffle)} style={[styles.toggle, state.queue.shuffle && tint]} accessibilityRole="button" accessibilityLabel="Shuffle">
            <Icon name="shuffle" size={22} color={state.queue.shuffle ? accent : colors.textDim} />
          </Pressable>
          <Pressable onPress={() => player.previous()} style={styles.touch} accessibilityRole="button" accessibilityLabel="Previous"><Icon name="skip-back" size={28} color={colors.text} /></Pressable>
          <Pressable onPress={() => player.toggle()} style={[styles.play, {backgroundColor: accent}]} accessibilityLabel={playing ? 'Pause' : 'Play'}>
            {state.buffering && state.playing && !remote ? <ActivityIndicator color={onColor} /> :
              <Icon name={playing ? 'pause' : 'play'} size={24} color={onColor} />}
          </Pressable>
          <Pressable onPress={() => player.next()} style={styles.touch} accessibilityRole="button" accessibilityLabel="Next"><Icon name="skip-forward" size={28} color={colors.text} /></Pressable>
          <Pressable onPress={() => player.cycleRepeat()} style={[styles.toggle, state.queue.repeat !== 'off' && tint]} accessibilityRole="button" accessibilityLabel={`Repeat ${state.queue.repeat}`}>
            <View style={styles.repeatGlyph}>
              <Icon name="repeat" size={22} color={state.queue.repeat !== 'off' ? accent : colors.textDim} />
              {state.queue.repeat === 'one' && <Text style={[styles.repeatOne, {color: accent}]}>1</Text>}
            </View>
          </Pressable>
        </View>

        <View style={styles.tabs}>
          {panels.map(name => (
            <Pressable key={name} onPress={() => setPanel(panel === name ? 'artwork' : name)} style={styles.tabTouch} accessibilityRole="tab"
              accessibilityState={{selected: panel === name}}>
              <View style={[styles.tabPill, panel === name && {backgroundColor: accent}]}>
              <Text style={[styles.tab, panel === name && {color: onColor, fontWeight: '700'}]}>{name === 'devices' ? 'Devices' : name[0].toUpperCase() + name.slice(1)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
      {added.overlays}
    </>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.deep, paddingHorizontal: spacing.lg},
  top: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  touch: touchTarget,
  toggle: {...touchTarget, borderRadius: 24, alignItems: 'center', justifyContent: 'center'},
  tabPill: {minHeight: 34, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center'},
  tabTouch: {minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs},
  chevron: {color: colors.text, fontSize: 26},
  middle: {flex: 1, marginBottom: spacing.md},
  artwork: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  titleRow: {flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm},
  titles: {flex: 1, gap: 2},
  heart: {color: colors.text, fontSize: 26},
  errorRow: {paddingVertical: spacing.xs},
  error: {color: colors.alert},
  controls: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: spacing.md},
  small: {color: colors.textDim, fontSize: 22},
  repeatGlyph: {alignItems: 'center', justifyContent: 'center'},
  repeatOne: {position: 'absolute', fontSize: 9, fontWeight: '700'},
  big: {color: colors.text, fontSize: 30},
  play: {width: 68, height: 68, borderRadius: 34, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center'},
  playGlyph: {fontSize: 24},
  tabs: {flexDirection: 'row', justifyContent: 'space-around'},
  tab: {color: colors.textDim, fontSize: 14, fontWeight: '600'},
});
