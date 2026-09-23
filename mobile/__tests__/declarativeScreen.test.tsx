import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {DeclarativeScreen} from '../src/satellites/DeclarativeScreen';
import type {UiScreen} from '../src/satellites/types';

/**
 * The generic renderer every Satellite's "mobile" route is turned into a
 * screen through (see "Exposing a mobile interface" in
 * docs/satellites.md). Covers the primitives the schema defines, the
 * forward-compatibility guarantee (an unknown item type is skipped, not a
 * crash), and that a button action actually reaches the caller.
 */
describe('DeclarativeScreen', () => {
  // `renderer` is untyped (see react-test-renderer.d.ts), so `tree`/`node`
  // are explicitly `any` here rather than implicitly - there's no type
  // available to give them instead.
  function texts(tree: any): string[] {
    return tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
  }

  it('renders text, status and list items', () => {
    const screen: UiScreen = {
      title: 'Status',
      sections: [
        {
          type: 'card',
          title: 'System',
          items: [
            {type: 'text', value: 'All good.'},
            {type: 'status', label: 'Platform', value: 'Linux'},
            {type: 'list', items: [{title: 'Entry one', subtitle: 'detail'}]},
          ],
        },
      ],
    };

    const tree = renderer.create(<DeclarativeScreen screen={screen} onAction={() => {}} />);

    const rendered = texts(tree);
    expect(rendered).toEqual(expect.arrayContaining(['System', 'All good.', 'Platform', 'Linux', 'Entry one', 'detail']));
  });

  it('skips an item type it does not recognize instead of crashing', () => {
    const screen: UiScreen = {
      title: 'Future',
      sections: [{type: 'card', items: [{type: 'chart', data: [1, 2, 3]} as any]}],
    };

    expect(() => renderer.create(<DeclarativeScreen screen={screen} onAction={() => {}} />)).not.toThrow();
  });

  it('fires the button action with no confirmation when none is set', () => {
    const onAction = jest.fn();
    const screen: UiScreen = {
      title: 'Actions',
      sections: [
        {type: 'card', items: [{type: 'button', label: 'Rescan', action: {route: 'rescan', method: 'POST'}}]},
      ],
    };

    const tree = renderer.create(<DeclarativeScreen screen={screen} onAction={onAction} />);
    tree.root.findByProps({title: 'Rescan'}).props.onPress();

    expect(onAction).toHaveBeenCalledWith({route: 'rescan', method: 'POST'});
  });
});
