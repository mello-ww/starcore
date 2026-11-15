import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SecureWindow} from '../src/components/SecureWindow';
import {RevealSecret, SecretPrompt} from '../src/satellites/ui/SecretPrompt';

// A Modal is a window of its own, which the app's capture protection (privacy.setSecure, on the
// app's window) doesn't reach: what shows private content in one holds a SecureWindow marker,
// which makes that window uncapturable too (android/.../privacy/SecureWindowManager.kt).

type Tree = ReturnType<typeof renderer.create>;

const markers = (tree: Tree) =>
  tree.root.findAll((node: any) => node.props.testID === 'secure-window' && typeof node.type === 'string');

async function mount(element: React.ReactElement) {
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('SecureWindow', () => {
  it('is a marker that draws nothing and takes no space', async () => {
    const tree = await mount(<SecureWindow />);
    const [marker] = markers(tree);
    expect(marker).toBeDefined();
    expect(marker.props.pointerEvents).toBe('none');
    expect(marker.props.style).toMatchObject({position: 'absolute', width: 0, height: 0});
    expect(marker.children).toHaveLength(0);
  });

  it('is absent where nothing private shows', async () => {
    expect(markers(await mount(<SecureWindow secure={false} />))).toHaveLength(0);
  });

  it('is in the prompt that asks for a secret', async () => {
    const tree = await mount(
      <SecretPrompt ask={{kind: 'recovery-key', isNew: false, again: false, error: null}} satellite="Safe" onDone={() => undefined} />,
    );
    expect(markers(tree)).toHaveLength(1);
  });

  it('is in the dialog that shows a revealed secret', async () => {
    const tree = await mount(<RevealSecret value="AAAA-BBBB" satellite="Safe" onDone={() => undefined} />);
    expect(markers(tree)).toHaveLength(1);
  });
});
