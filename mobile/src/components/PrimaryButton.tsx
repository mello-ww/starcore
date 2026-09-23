import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text} from 'react-native';
import {colors, radius, spacing} from '../theme';

interface Props {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary';
}

/** A single, consistent touch target (48dp tall - well above Android's own
 * 48dp accessibility minimum) for every primary action in the app, so
 * "what does a button look like" is answered once. */
export function PrimaryButton({title, onPress, disabled, loading, variant = 'primary'}: Props) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled: !!disabled || !!loading}}
      onPress={onPress}
      disabled={disabled || loading}
      style={({pressed}) => [
        styles.button,
        isPrimary ? styles.primary : styles.secondary,
        (disabled || loading) && styles.disabled,
        pressed && !disabled && !loading && styles.pressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.void : colors.text} />
      ) : (
        <Text style={[styles.label, isPrimary ? styles.primaryLabel : styles.secondaryLabel]}>{title}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primary: {
    backgroundColor: colors.royal,
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.lineBright,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  primaryLabel: {
    color: colors.text,
  },
  secondaryLabel: {
    color: colors.text,
  },
});
