import React, {createContext, useContext} from 'react';
import {requireNativeComponent, UIManager, type HostComponent, type StyleProp, type ViewStyle} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';

import {ICONS, type OwnIcons} from '../satellites/ui/contract';

/**
 * An icon a document or a Satellite names: one of the shared set (a Feather glyph), or one of
 * the Satellite's own (UI contract 1.2), whose path data the Engine validated from its icons/
 * folder. An own icon is stroked by the native StarCoreGlyph view
 * (android/.../glyph/GlyphView.kt) in the colour given here, like a shared one; one the Engine
 * refused, or wherever the native view isn't there (tests), draws its shared fallback.
 *
 * The own icons come from `icons`, else from the nearest `GlyphIcons` (a document's screen
 * provides its document's). Any other name is drawn as the Feather glyph it names.
 */
const NAME = 'StarCoreGlyph';
type NativeProps = {paths: string[]; stroke: number; color: string; style?: StyleProp<ViewStyle>; testID?: string};
let NativeGlyph: HostComponent<NativeProps> | null = null;

// the native view, once the app has it (it always has in a build; tests have it only when they say so)
function nativeGlyph(): HostComponent<NativeProps> | null {
  if (!NativeGlyph && UIManager.getViewManagerConfig?.(NAME)) {
    NativeGlyph = requireNativeComponent<NativeProps>(NAME);
  }
  return NativeGlyph;
}

const OwnIconsContext = createContext<OwnIcons | null>(null);

/** The own icons the glyphs beneath may name: a document's `icons`. */
export function GlyphIcons({icons, children}: {icons?: OwnIcons | null; children: React.ReactNode}) {
  return <OwnIconsContext.Provider value={icons ?? null}>{children}</OwnIconsContext.Provider>;
}

/** The own icons of the document being drawn, or null. */
export function useOwnIcons(): OwnIcons | null {
  return useContext(OwnIconsContext);
}

export function Glyph({
  name, size, color, icons, style, testID,
}: {
  name: string;
  size: number;
  color: string;
  icons?: OwnIcons | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const provided = useOwnIcons();
  const own = icons !== undefined ? icons : provided;
  const mine = own && Object.prototype.hasOwnProperty.call(own, name) ? own[name] : null;
  const Native = mine && Array.isArray(mine.paths) ? nativeGlyph() : null;
  if (mine && Array.isArray(mine.paths) && Native) {
    return (
      <Native
        paths={mine.paths}
        stroke={typeof mine.stroke === 'number' ? mine.stroke : 2}
        color={color}
        style={[{width: size, height: size}, style]}
        testID={testID}
      />
    );
  }
  // a refused own icon draws its shared fallback; any other name is the caller's Feather glyph
  const shared = mine ? (ICONS.has(mine.fallback) ? mine.fallback : 'circle') : name;
  return <Icon name={shared} size={size} color={color} style={style as any} testID={testID} />;
}
