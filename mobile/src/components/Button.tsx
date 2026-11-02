import React from 'react';
import {ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, ViewStyle} from 'react-native';
import {TOUCH_TARGET, tokens, useAccent} from '../theme';

const {palette, radii, space, type} = tokens;

interface Props {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A StarCore action button: accent for the main action, grey otherwise, outlined red for destructive ones. */
export function Button({title, onPress, disabled, loading, variant = 'primary', style, testID}: Props) {
  const {color: accent, onColor} = useAccent();
  const inactive = !!disabled || !!loading;
  const textColor = variant === 'primary' ? onColor : variant === 'danger' ? palette.danger : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled: inactive}}
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      style={({pressed}) => [
        styles.button,
        variant === 'primary' && {backgroundColor: accent},
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.danger,
        inactive && styles.inactive,
        pressed && !inactive && styles.pressed,
        style,
      ]}>
      {loading ? <ActivityIndicator color={textColor} /> : <Text style={[type.label, {color: textColor}]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.xl,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: {backgroundColor: palette.controlStrong},
  danger: {borderWidth: 1, borderColor: 'rgba(238, 68, 75, 0.5)'},
  inactive: {opacity: 0.45},
  pressed: {opacity: 0.8},
});
