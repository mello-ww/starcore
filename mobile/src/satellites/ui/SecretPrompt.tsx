import React, {useEffect, useRef, useState} from 'react';
import {Clipboard, Modal, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {PrimaryButton} from '../../components/PrimaryButton';
import {SecureWindow} from '../../components/SecureWindow';
import {StarSwitch} from '../../components/StarSwitch';
import {colors, spacing, tokens, typography, useAccentStyles} from '../../theme';
import type {SecretAsk} from './secrets';

/**
 * This app's own dialogs for a protected document's secrets (UI contract 1.2, ./secrets.ts): the
 * prompt that asks for one secret, and the one that shows a revealed secret once. The document
 * only names what to ask; the words are this app's and name the Satellite asking. What is typed
 * lives only in the field and is handed to the one request; what is revealed lives only in the
 * dialog, until the person says it is stored. Both are Modals, windows of their own, so each
 * makes its window uncapturable itself (SecureWindow).
 */

const WORDS = {
  pin: {name: 'PIN', enter: 'Enter your PIN', choose: 'Choose a new PIN', again: 'Enter the new PIN again'},
  'recovery-key': {name: 'recovery key', enter: 'Enter your recovery key', choose: '', again: ''},
} as const;

export function SecretPrompt({ask, satellite, onDone}: {ask: SecretAsk; satellite: string; onDone: (value: string | null) => void}) {
  const accentStyle = useAccentStyles();
  const words = WORDS[ask.kind] ?? WORDS.pin;
  const pin = ask.kind === 'pin';
  const title = ask.isNew ? (ask.again ? words.again : words.choose) : words.enter;
  const who = satellite || 'This interface';
  const [value, setValue] = useState('');
  const settled = useRef(false);
  const handlers = useRef(onDone);
  handlers.current = onDone;
  const finish = (answer: string | null) => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    setValue('');
    handlers.current(answer);
  };
  useEffect(
    () => () => {
      if (!settled.current) {
        settled.current = true;
        handlers.current(null); // closed any other way: nothing is sent
      }
    },
    [],
  );
  const typed = pin ? value : value.trim();
  return (
    <Modal transparent animationType="fade" onRequestClose={() => finish(null)} statusBarTranslucent>
      <View style={styles.backdrop}>
        <SecureWindow />
        <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
          <View style={styles.card} testID="secret-prompt" accessibilityViewIsModal>
            <Icon name="lock" size={32} color={accentStyle.color} />
            <Text style={typography.heading}>{title}</Text>
            <Text style={[typography.caption, styles.centerText]}>
              {ask.isNew ? `${who} asks for a new ${words.name}: 4 to 12 digits.` : `${who} asks for your ${words.name} to do this.`}
            </Text>
            <TextInput
              value={value}
              onChangeText={text => setValue(pin ? text.replace(/\D/g, '') : text)}
              placeholder={pin ? 'PIN' : 'Recovery key'}
              placeholderTextColor={colors.textFaint}
              keyboardType={pin ? 'number-pad' : 'default'}
              secureTextEntry={pin}
              autoCapitalize={pin ? 'none' : 'characters'}
              autoCorrect={false}
              maxLength={pin ? 12 : 64}
              autoFocus
              onSubmitEditing={() => typed && finish(typed)}
              style={[styles.input, !pin && styles.keyInput]}
              accessibilityLabel={words.name}
              autoComplete="off"
              importantForAutofill="no"
              testID="secret-input"
            />
            {ask.error ? (
              <Text style={[styles.message, styles.centerText]} accessibilityLiveRegion="polite">
                {ask.error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <PrimaryButton title={ask.isNew && !ask.again ? 'Next' : 'Continue'} onPress={() => finish(typed)} disabled={!typed} />
              <PrimaryButton title="Cancel" variant="secondary" onPress={() => finish(null)} />
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

export function RevealSecret({value, satellite, onDone}: {value: string; satellite: string; onDone: () => void}) {
  const accentStyle = useAccentStyles();
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    // never dismissed by Back: only once it is stored
    <Modal transparent animationType="fade" onRequestClose={() => undefined} statusBarTranslucent>
      <View style={styles.backdrop}>
        <SecureWindow />
        <ScrollView contentContainerStyle={styles.center}>
          <View style={styles.card} testID="secret-reveal" accessibilityViewIsModal>
            <Icon name="lock" size={32} color={accentStyle.color} />
            <Text style={typography.heading}>Store this somewhere safe</Text>
            <Text style={[typography.caption, styles.centerText]}>
              {`${satellite || 'This interface'} shows it this once and never again. Anyone who has it can reset your PIN.`}
            </Text>
            <Text selectable style={styles.revealed} testID="secret-revealed">
              {value}
            </Text>
            <PrimaryButton
              title={copied ? 'Copied' : 'Copy'}
              variant="secondary"
              onPress={() => {
                Clipboard.setString(value);
                setCopied(true);
              }}
            />
            <View style={styles.stored}>
              <Text style={[typography.body, styles.storedLabel]}>I've stored it somewhere safe</Text>
              <StarSwitch accessibilityLabel="I've stored it somewhere safe" value={stored} onValueChange={setStored} />
            </View>
            <View style={styles.actions}>
              <PrimaryButton title="Done" onPress={onDone} disabled={!stored} />
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.75)'},
  center: {flexGrow: 1, justifyContent: 'center', padding: spacing.lg},
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: tokens.radii.card,
    backgroundColor: colors.surface,
  },
  centerText: {textAlign: 'center'},
  input: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: tokens.radii.control,
    borderWidth: 1,
    borderColor: tokens.palette.controlStrong,
    backgroundColor: tokens.palette.field,
    color: colors.text,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
  },
  keyInput: {fontFamily: 'monospace', fontSize: 16, letterSpacing: 1},
  message: {color: colors.alert, fontSize: 13},
  actions: {alignSelf: 'stretch', gap: spacing.sm, marginTop: spacing.xs},
  revealed: {
    alignSelf: 'stretch',
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: tokens.radii.control,
    backgroundColor: tokens.palette.field,
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 16,
    textAlign: 'center',
  },
  stored: {alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs},
  storedLabel: {flex: 1},
});
