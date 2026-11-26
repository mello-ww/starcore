import React, {useState} from 'react';
import {Image, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Glyph} from '../../components/Glyph';
import {ModalSafeArea} from '../../components/ModalSafeArea';
import {PrimaryButton} from '../../components/PrimaryButton';
import {StarInput} from '../../components/StarInput';
import {TOUCH_TARGET, tokens} from '../../theme';
import type {ChooseAnswer, ChooseOffer} from './choose';
import {Sheet} from './RowMenu';

const {palette, space, type, radii} = tokens;

/**
 * The choose action's sheet (UI contract 1.2, change 8): its title, a "new" line that opens a
 * name field, then one line per row with its picture, title and subtitle. Choosing a line, or
 * creating, closes it with the answer; the backdrop and Back close it with null.
 */
export function ChooseSheet({
  offer, mediaSource, onDone,
}: {
  offer: ChooseOffer;
  mediaSource: (route: string) => {uri: string; headers?: Record<string, string>};
  onDone: (answer: ChooseAnswer) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const close = () => onDone(null);
  const create = () => {
    const typed = name.trim();
    if (typed) {
      onDone({create: typed});
    }
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={close} statusBarTranslucent>
      <ModalSafeArea>
        <Sheet onClose={close}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {offer.title || 'Choose'}
          </Text>
          <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled" testID="choose-sheet">
            {offer.create && !naming && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={offer.create.label || 'New'}
                testID="choose-new"
                onPress={() => setNaming(true)}
                style={({pressed}) => [styles.row, pressed && styles.pressed]}>
                <View style={[styles.thumb, styles.plus]}>
                  <Glyph name="plus" size={22} color={palette.text} />
                </View>
                <Text style={styles.label} numberOfLines={1}>
                  {offer.create.label || 'New'}
                </Text>
              </Pressable>
            )}
            {offer.create && naming && (
              <View style={styles.form}>
                <StarInput
                  value={name}
                  onChangeText={setName}
                  onSubmitEditing={create}
                  placeholder={offer.create.field}
                  placeholderTextColor={palette.text3}
                  accessibilityLabel={offer.create.field || offer.create.label}
                  autoFocus
                  returnKeyType="done"
                  style={styles.input}
                  testID="choose-name"
                />
                <PrimaryButton title="Create" onPress={create} disabled={!name.trim()} />
              </View>
            )}
            {!offer.rows.length && (
              <Text style={styles.empty}>{offer.empty || 'There is nothing to choose from yet.'}</Text>
            )}
            {offer.rows.map((entry, index) => (
              <Pressable
                key={`${index}:${entry.title}`}
                accessibilityRole="button"
                accessibilityLabel={entry.subtitle ? `${entry.title}, ${entry.subtitle}` : entry.title}
                testID={`choose-row-${index}`}
                onPress={() => onDone({row: entry.row})}
                style={({pressed}) => [styles.row, pressed && styles.pressed]}>
                {entry.image ? (
                  <Image source={mediaSource(entry.image)} style={styles.thumb} resizeMode="cover" />
                ) : (
                  <View style={styles.thumb} />
                )}
                <View style={styles.main}>
                  <Text style={styles.label} numberOfLines={1}>
                    {entry.title}
                  </Text>
                  {entry.subtitle !== '' && (
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {entry.subtitle}
                    </Text>
                  )}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </Sheet>
      </ModalSafeArea>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: {...type.label, fontWeight: '600', color: palette.text},
  rows: {maxHeight: 460},
  row: {
    minHeight: Math.max(TOUCH_TARGET, 56),
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radii.control,
  },
  pressed: {backgroundColor: palette.control},
  thumb: {width: 44, height: 44, borderRadius: radii.control, backgroundColor: palette.control},
  plus: {alignItems: 'center', justifyContent: 'center'},
  main: {flex: 1, minWidth: 0},
  label: {...type.body, color: palette.text, flexShrink: 1},
  subtitle: {...type.caption, color: palette.text2},
  form: {gap: space.sm, paddingVertical: space.sm},
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: palette.controlStrong,
    backgroundColor: palette.field,
    ...type.body,
    color: palette.text,
  },
  empty: {...type.caption, color: palette.text2, padding: space.sm},
});
