import React, {createContext, useContext} from 'react';
import {View} from 'react-native';

/** How much of the bottom of a screen the floating mini-player covers: its measured height
 * (with its margin above the tab bar), plus a small gap, or 0 while no player is shown.
 * MainTabs measures the player and provides it; screens never guess a size. */
const InsetContext = createContext(0);

export function FloatingPlayerInsetProvider({value, children}: {value: number; children: React.ReactNode}) {
  return <InsetContext.Provider value={value}>{children}</InsetContext.Provider>;
}

export function useFloatingPlayerInset(): number {
  return useContext(InsetContext);
}

/** The space a scrolling screen leaves at its end so its last row can scroll clear of the
 * floating player. Put it last in a ScrollView, or as a list's footer. It is empty while the
 * player is hidden or put away. */
export function FloatingPlayerSpacer() {
  const inset = useFloatingPlayerInset();
  return inset > 0 ? <View style={{height: inset}} testID="floating-player-spacer" /> : null;
}
