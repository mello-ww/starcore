import React from 'react';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {Reveal, useSlidingSelection} from '../src/components/motion';

type Tree = ReturnType<typeof renderer.create>;

// the shared motion: an accent that slides between a row's options, and a panel that appears

function Row({selected, remember}: {selected: number; remember?: string}) {
  const {indicator, onItemLayout, selectedBackground} = useSlidingSelection(selected, {remember});
  return (
    <View>
      {indicator}
      {['a', 'b', 'c'].map((key, index) => (
        <Pressable
          key={key}
          testID={`item-${key}`}
          onLayout={onItemLayout(index)}
          style={selectedBackground(index === selected)}>
          <Text>{key}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const frames = [
  {x: 0, y: 0, width: 60, height: 36},
  {x: 70, y: 0, width: 90, height: 36},
  {x: 170, y: 0, width: 50, height: 36},
];

function layOut(tree: Tree) {
  ['a', 'b', 'c'].forEach((key, index) =>
    tree.root.findByProps({testID: `item-${key}`}).props.onLayout({nativeEvent: {layout: frames[index]}}),
  );
}

// where the indicator sits (its outer view's translation) and how it looks (its pill)
const indicatorStyle = (tree: Tree) => {
  const pill = tree.root.findByProps({testID: 'sliding-selection'});
  const outer = StyleSheet.flatten(pill.parent!.props.style);
  const [{translateX}] = outer.transform as any[];
  return {...StyleSheet.flatten(pill.props.style), opacity: outer.opacity, left: translateX};
};

describe('the sliding selection', () => {
  beforeEach(() => {
    // reduced motion: every move lands at once, so the test reads where it ends
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('stays hidden until the selected option has a place, then sits behind it', async () => {
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(<Row selected={1} />);
    });
    expect(indicatorStyle(tree).opacity).toBe(0);
    await act(async () => layOut(tree));
    const style = indicatorStyle(tree);
    expect(style.opacity).toBe(1);
    expect(JSON.stringify([style.left, style.width])).toBe('[70,90]');
  });

  it('follows the selection to another option', async () => {
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(<Row selected={0} />);
    });
    await act(async () => layOut(tree));
    await act(async () => tree.update(<Row selected={2} />));
    const style = indicatorStyle(tree);
    expect(JSON.stringify([style.left, style.width])).toBe('[170,50]');
  });

  it('hides when nothing is selected', async () => {
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(<Row selected={-1} />);
    });
    await act(async () => layOut(tree));
    expect(indicatorStyle(tree).opacity).toBe(0);
  });

  it('lets the selected option paint its own accent until the indicator is placed', async () => {
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(<Row selected={1} />);
    });
    const background = () => StyleSheet.flatten(tree.root.findByProps({testID: 'item-b'}).props.style)?.backgroundColor;
    expect(background()).not.toBe('transparent');
    expect(background()).toBeTruthy();
    await act(async () => layOut(tree));
    expect(background()).toBe('transparent');
    expect(tree.root.findByProps({testID: 'item-a'}).props.style).toBeNull();
  });
});

describe('a remembered sliding selection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts a row drawn again where it last had the selection', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    let first!: Tree;
    await act(async () => {
      first = renderer.create(<Row selected={0} remember="row-test" />);
    });
    await act(async () => layOut(first));
    await act(async () => first.unmount());
    let second!: Tree;
    await act(async () => {
      second = renderer.create(<Row selected={2} remember="row-test" />);
    });
    await act(async () => layOut(second));
    // the move from the old place has started: it is visible and not yet at the new option
    const style = indicatorStyle(second);
    expect(style.opacity).toBe(1);
    expect(style.left).not.toBe(170);
    second.unmount();
  });

  it('carries on the move when the row is drawn once more while it slides', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const mount = async (selected: number) => {
      let tree!: Tree;
      await act(async () => {
        tree = renderer.create(<Row selected={selected} remember="row-twice" />);
      });
      await act(async () => layOut(tree));
      return tree;
    };
    (await mount(0)).unmount();
    (await mount(2)).unmount();
    // a third drawing right away is still on its way to the new option, not already there
    const third = await mount(2);
    expect(indicatorStyle(third).left).not.toBe(170);
    third.unmount();
  });
});

describe('a reveal', () => {
  it('shows its content in place', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    let tree!: Tree;
    await act(async () => {
      tree = renderer.create(
        <Reveal>
          <Text>panel</Text>
        </Reveal>,
      );
    });
    expect(tree.root.findByType(Text).props.children).toBe('panel');
    jest.restoreAllMocks();
  });
});
