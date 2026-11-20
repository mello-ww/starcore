import React, {useEffect, useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Glyph} from '../../components/Glyph';
import {ModalSafeArea} from '../../components/ModalSafeArea';
import {useOptionalAudioHost} from '../../media/AudioHost';
import {TOUCH_TARGET, tokens} from '../../theme';
import {resolve, type Scope} from './contract';
import type {RowEntry} from './rows';

const {palette, space, type, radii} = tokens;

const asText = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/**
 * A row's or a tile's menu (UI contract 1.2 `menu`) as a bottom sheet: its title, then one line
 * per entry this app can run, already filtered (rows.ts). Choosing one closes the sheet and runs
 * it; the backdrop and Back close it without running anything.
 */
export function RowMenuSheet({
  title, entries, scope, onRun, onClose,
}: {
  title: string;
  entries: RowEntry[];
  scope: Scope;
  onRun: (entry: RowEntry) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <ModalSafeArea>
        <Sheet onClose={onClose}>
          {title !== '' && (
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
          )}
          <ScrollView style={styles.entries} testID="row-menu">
            {entries.map((entry, index) => {
              const label = asText(resolve(entry.label, scope));
              const danger = entry.style === 'danger';
              return (
                <Pressable
                  key={`${index}:${label}`}
                  accessibilityRole="menuitem"
                  accessibilityLabel={label}
                  testID={`row-menu-${index}`}
                  onPress={() => {
                    onClose();
                    onRun(entry);
                  }}
                  style={({pressed}) => [styles.entry, pressed && styles.pressed]}>
                  {typeof entry.icon === 'string' && (
                    <Glyph name={entry.icon} size={18} color={danger ? palette.danger : palette.textIcon} />
                  )}
                  <Text style={[styles.label, danger && {color: palette.danger}]} numberOfLines={1}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Sheet>
      </ModalSafeArea>
    </Modal>
  );
}

/** The bottom sheet: clear of the status bar above it and the gesture bar below it (shared with
 * the choose action's sheet, ChooseSheet.tsx). */
export function Sheet({children, onClose}: {children: React.ReactNode; onClose: () => void}) {
  const insets = useSafeAreaInsets();
  return (
    <Pressable style={[styles.backdrop, {paddingTop: insets.top}]} onPress={onClose} accessibilityLabel="Close">
      <Pressable style={[styles.sheet, {paddingBottom: space.lg + insets.bottom}]} onPress={() => undefined}>
        {children}
      </Pressable>
    </Pressable>
  );
}

/**
 * The id of the track the app's audio host plays now, when it plays from `satellite` (the
 * `audio.library` provider), else null - so a list marks its playing row (`item.audio`, 1.2).
 * `watch` false (a list without `item.audio`) subscribes to nothing.
 */
export function usePlayingId(satellite: string | undefined, watch = true): string | null {
  const host = useOptionalAudioHost();
  const player = watch && satellite && host?.provider?.satellite === satellite ? host.player : null;
  const [id, setId] = useState<string | null>(() => idOf(player?.state));
  useEffect(() => {
    if (!player) {
      setId(null);
      return undefined;
    }
    setId(idOf(player.state));
    return player.subscribe(state => setId(idOf(state)));
  }, [player]);
  return id;
}

function idOf(state: any): string | null {
  const id = state?.track?.id;
  return id === null || id === undefined || id === '' ? null : String(id);
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: palette.card,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    gap: space.sm,
  },
  title: {...type.label, fontWeight: '600', color: palette.text},
  entries: {maxHeight: 420},
  entry: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radii.control,
  },
  label: {...type.body, color: palette.text, flexShrink: 1},
  pressed: {backgroundColor: palette.control},
});
