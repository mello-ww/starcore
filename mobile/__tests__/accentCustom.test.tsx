import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AccentCustomColor, PICKER_COLORS, PICKER_COLUMNS} from '../src/components/AccentCustomColor';
import {ACCENT_STORAGE_KEY, AccentProvider, useAccent, useAccentStyles} from '../src/theme/AccentContext';
import {contrastRatio, normalizeHex, onAccentFor} from '../src/theme/tokens';

describe('accent colour helpers', () => {
  it('normalises and validates HEX values', () => {
    expect(normalizeHex('#EE444B')).toBe('#ee444b');
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex(' #0f0 ')).toBe('#00ff00');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('#gggggg')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });

  it('picks the foreground with the better contrast', () => {
    // the presets keep their dark ink
    expect(onAccentFor('#ee444b')).toBe('#141215');
    expect(onAccentFor('#e6e7eb')).toBe('#141215');
    // a dark custom accent switches to white
    expect(onAccentFor('#1a237e')).toBe('#ffffff');
    for (const hex of ['#000000', '#1a237e', '#7a1fa2', '#ee444b', '#ffff00', '#ffffff', '#808080']) {
      expect(contrastRatio(hex, onAccentFor(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('custom accent', () => {
  beforeEach(() => AsyncStorage.clear());

  let seen: ReturnType<typeof useAccentStyles> & {accent: string};
  function Probe() {
    const styles = useAccentStyles();
    seen = {...styles, accent: useAccent().accent};
    return null;
  }

  async function mount() {
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(
        <AccentProvider>
          <AccentCustomColor />
          <Probe />
        </AccentProvider>,
      );
    });
    return tree;
  }

  it('previews, applies and saves a valid HEX, and ignores an invalid one', async () => {
    const tree = await mount();
    const field = () => tree.root.findByProps({testID: 'accent-hex'});

    await act(async () => field().props.onChangeText('#1A23'));
    expect(seen.color).toBe('#ee444b');
    expect(field().props.style).toEqual(expect.arrayContaining([expect.objectContaining({borderColor: '#ee444b'})]));

    await act(async () => field().props.onChangeText('#1A237E'));
    expect(seen.accent).toBe('custom');
    expect(seen.color).toBe('#1a237e');
    expect(seen.onFill).toEqual({color: '#ffffff'});
    expect(await AsyncStorage.getItem(ACCENT_STORAGE_KEY)).toBe('#1a237e');
  });

  it('applies a colour from the picker grid', async () => {
    const tree = await mount();
    await act(async () => tree.root.findByProps({testID: 'accent-color-ffffff'}).props.onPress());
    expect(seen.color).toBe('#ffffff');
    expect(seen.onColor).toBe('#141215');
  });

  it('keeps the grid to a few large swatches', async () => {
    const tree = await mount();
    expect(PICKER_COLUMNS).toBe(7);
    expect(PICKER_COLORS.every(row => row.length === PICKER_COLUMNS)).toBe(true);
    const swatch = tree.root.findByProps({testID: 'accent-color-ffffff'});
    expect(swatch.props.hitSlop).toBeGreaterThanOrEqual(4);
  });

  it('restores a saved custom colour', async () => {
    await AsyncStorage.setItem(ACCENT_STORAGE_KEY, '#45C486');
    await mount();
    expect(seen.accent).toBe('custom');
    expect(seen.color).toBe('#45c486');
  });
});
