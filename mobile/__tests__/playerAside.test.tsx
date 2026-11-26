import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {holdPlayerAside, usePlayerAside} from '../src/media/ui/dock';

// the floating player steps out of the way while a full-screen media viewer is open
function Probe() {
  return <Text>{usePlayerAside() ? 'aside' : 'shown'}</Text>;
}

describe('holding the player aside', () => {
  it('lasts while any viewer holds it, and a release counts once', () => {
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<Probe />);
    });
    const shown = () => tree.root.findByType(Text).props.children;
    expect(shown()).toBe('shown');
    let first!: () => void;
    let second!: () => void;
    act(() => {
      first = holdPlayerAside();
      second = holdPlayerAside();
    });
    expect(shown()).toBe('aside');
    act(() => {
      first();
      first();
    });
    expect(shown()).toBe('aside');
    act(() => second());
    expect(shown()).toBe('shown');
  });
});
