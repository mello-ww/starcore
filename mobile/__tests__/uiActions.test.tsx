import React from 'react';
import {Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import type {UiBlock} from '../src/satellites/ui/contract';

// the actions block and its dropdowns (UI contract 1.2, change 11): a page's actions on one row
function context(succeeds = true): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => succeeds),
    readCapability: jest.fn(),
    forms: {},
    setEditing: jest.fn(),
    pageState: {},
    setPageState: jest.fn(),
  };
}

function render(block: UiBlock, data: any, ctx: BlockContext) {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<UiBlocks blocks={[block]} scope={{data, page: data, params: {}, state: {}}} context={ctx} />);
  });
  return tree;
}

const remove = {route: 'delete', then: 'back'};
const row: UiBlock = {
  type: 'actions',
  blocks: [
    {type: 'button', label: 'Up', visible: '$.parent', action: {navigate: 'folder'}},
    {type: 'button', label: 'Refresh', action: {route: 'scan', then: 'refresh'}},
    {type: 'dropdown', label: 'Manage', blocks: [
      {type: 'text', text: 'Careful'},
      {type: 'button', label: 'Delete', style: 'danger', action: remove},
    ]},
  ],
};

const texts = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map((node: any) => node.props.children).filter((child: any) => typeof child === 'string');
const toggle = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAll((node: any) => node.type === Pressable && node.props.accessibilityState?.expanded !== undefined)[0];

describe('the actions block', () => {
  it('draws its shown buttons and dropdowns on one row, and keeps a dropdown closed until pressed', () => {
    const tree = render(row, {parent: null}, context());
    expect(texts(tree)).toEqual(['Refresh', 'Manage']);
    expect(toggle(tree).props.accessibilityState).toEqual({expanded: false});
  });

  it('opens a dropdown under the row, and an action inside it that succeeds closes it', async () => {
    const ctx = context();
    const tree = render(row, {parent: '/home'}, ctx);
    act(() => toggle(tree).props.onPress());
    expect(toggle(tree).props.accessibilityState).toEqual({expanded: true});
    expect(texts(tree)).toEqual(['Up', 'Refresh', 'Manage', 'Careful', 'Delete']);
    const del = tree.root.findAll((node: any) => node.type === Pressable && node.props.onPress)
      .find((node: any) => node.findAllByType(Text).some((t: any) => t.props.children === 'Delete'))!;
    await act(async () => {
      await del.props.onPress();
    });
    expect((ctx.runAction as jest.Mock).mock.calls[0][0]).toBe(remove);
    expect(texts(tree)).toEqual(['Up', 'Refresh', 'Manage']);
  });

  it('stays open when the action failed, and closes when its button is pressed again', async () => {
    const tree = render(row, {parent: null}, context(false));
    act(() => toggle(tree).props.onPress());
    const del = tree.root.findAll((node: any) => node.type === Pressable && node.props.onPress)
      .find((node: any) => node.findAllByType(Text).some((t: any) => t.props.children === 'Delete'))!;
    await act(async () => {
      await del.props.onPress();
    });
    expect(texts(tree)).toContain('Delete');
    act(() => toggle(tree).props.onPress());
    expect(texts(tree)).not.toContain('Delete');
  });

  it('is not drawn when none of its actions is shown, and a dropdown outside a row is not drawn', () => {
    const hidden: UiBlock = {type: 'actions', blocks: [{type: 'button', label: 'Up', visible: '$.parent', action: {navigate: 'x'}}]};
    expect(render(hidden, {parent: null}, context()).toJSON()).toBeNull();
    expect(render(row.blocks[2], {}, context()).toJSON()).toBeNull();
  });
});
