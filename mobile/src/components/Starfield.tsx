import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import {colors} from '../theme';

/**
 * Touch-UI take on Mission Control's `.starfield` backdrop (see
 * mission_control/style.css) - a sparse scatter of small dots, not an
 * animated gradient layer. CSS radial-gradients don't have a direct React
 * Native equivalent, and a full animation loop is unnecessary battery cost
 * on a phone for a purely decorative background, so this renders a fixed
 * scatter of absolutely-positioned dots instead - same visual language
 * (StarCore's dark sky full of small, faint stars), adapted rather than
 * ported line-for-line, per "adapt these elements ... instead of copying
 * the desktop layout blindly."
 */
export function Starfield({count = 40}: {count?: number}) {
  const stars = useMemo(
    () =>
      Array.from({length: count}, (_, index) => ({
        key: index,
        top: `${Math.random() * 100}%`,
        left: `${Math.random() * 100}%`,
        size: 1 + Math.random() * 1.6,
        opacity: 0.15 + Math.random() * 0.5,
      })),
    [count],
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {stars.map(star => (
        <View
          key={star.key}
          style={{
            position: 'absolute',
            top: star.top as any,
            left: star.left as any,
            width: star.size,
            height: star.size,
            borderRadius: star.size,
            backgroundColor: colors.text,
            opacity: star.opacity,
          }}
        />
      ))}
    </View>
  );
}
