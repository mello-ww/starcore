import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {colors} from '../theme';

/** StarCore's one Settings glyph: Feather's gear, also used by the Settings tab and Mission Control. */
export const SETTINGS_ICON = 'settings';

/** The gear that opens a screen's settings - neutral, with a full 44pt touch target. */
export function SettingsButton({onPress, label}: {onPress: () => void; label: string}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({pressed}) => [styles.button, pressed && styles.pressed]}>
      <Icon name={SETTINGS_ICON} size={22} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center'},
  pressed: {backgroundColor: colors.raised},
});
