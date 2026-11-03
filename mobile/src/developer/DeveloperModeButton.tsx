import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {colors, useAccentStyles} from '../theme';
import {useDeveloperMode} from './DeveloperModeContext';

/** The discreet top-right Developer Mode switch: a terminal glyph, accent-coloured while on. */
export function DeveloperModeButton() {
  const {enabled, setEnabled} = useDeveloperMode();
  const accent = useAccentStyles();
  return (
    <Pressable
      onPress={() => setEnabled(!enabled)}
      accessibilityRole="switch"
      accessibilityLabel="Developer Mode"
      accessibilityState={{checked: enabled}}
      hitSlop={6}
      testID="developer-mode-button"
      style={({pressed}) => [styles.button, enabled && styles.on, pressed && styles.pressed]}>
      <Icon name="terminal" size={20} color={enabled ? accent.color : colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center'},
  on: {backgroundColor: colors.raised},
  pressed: {backgroundColor: colors.raised},
});
