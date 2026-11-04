import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {FloatingPlayerInsetProvider, FloatingPlayerSpacer} from '../src/components/FloatingPlayerInset';

function render(value: number) {
  let tree: ReturnType<typeof renderer.create> | undefined;
  act(() => {
    tree = renderer.create(
      <FloatingPlayerInsetProvider value={value}>
        <FloatingPlayerSpacer />
      </FloatingPlayerInsetProvider>,
    );
  });
  return tree!;
}

describe('the floating player spacer', () => {
  it('leaves the measured height of the player at the end of a screen', () => {
    const spacer = render(86).root.findByProps({testID: 'floating-player-spacer'});
    expect(spacer.props.style).toEqual({height: 86});
  });

  it('takes no room while the player is hidden or put away', () => {
    expect(render(0).toJSON()).toBeNull();
  });
});
