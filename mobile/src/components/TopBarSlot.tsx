import React, {createContext, useContext} from 'react';
import {StyleSheet, View} from 'react-native';

/** One control the app shows in every header's top-right group, beside Developer Mode (Music's
 * now-playing disc today). Headers render <TopBarSlot />; what goes in it is provided once,
 * above the navigation, so no header names a Satellite. */
const SlotContext = createContext<React.ComponentType | null>(null);

export function TopBarSlotProvider({component, children}: {component: React.ComponentType | null; children: React.ReactNode}) {
  return <SlotContext.Provider value={component}>{children}</SlotContext.Provider>;
}

/** The slot itself: as tall as the header buttons beside it, so whatever is in it is centred
 * on the same line as them. */
export function TopBarSlot() {
  const Component = useContext(SlotContext);
  if (!Component) {
    return null;
  }
  return (
    <View style={styles.slot}>
      <Component />
    </View>
  );
}

export const TOP_BAR_CONTROL = 44;

const styles = StyleSheet.create({
  slot: {height: TOP_BAR_CONTROL, justifyContent: 'center', alignItems: 'center'},
});
