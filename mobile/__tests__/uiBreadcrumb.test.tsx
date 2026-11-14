import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import type {UiBlock} from '../src/satellites/ui/contract';

// the breadcrumb block (UI contract 1.2): the way down to the current place on one row
function context(): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction: jest.fn(async () => true),
    readCapability: jest.fn(),
    forms: {},
    setEditing: jest.fn(),
    mediaSource: route => ({uri: `https://server.test/${route}`}),
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

const crumbs = [
  {name: '/', path: '/'},
  {name: 'home', path: '/home'},
  {name: 'demo', path: '/home/demo'},
];
const block: UiBlock = {
  type: 'breadcrumb', items: '$.crumbs', item: {title: '$.name'},
  action: {navigate: 'folder', params: {path: '$.path'}},
};

describe('the breadcrumb block', () => {
  it('shows each level, and every one but the last navigates to its own path', () => {
    const ctx = context();
    const tree = render(block, {crumbs}, ctx);
    const steps = tree.root.findAllByType(Pressable);
    expect(steps.map((step: any) => step.props.accessibilityLabel)).toEqual(['/', 'home', 'demo']);
    expect(steps.map((step: any) => step.props.disabled)).toEqual([false, false, true]);
    act(() => steps[1].props.onPress());
    expect(ctx.runAction).toHaveBeenCalledTimes(1);
    const [action, scope] = (ctx.runAction as jest.Mock).mock.calls[0];
    expect(action).toBe(block.action);
    expect(scope.data).toEqual(crumbs[1]);
  });

  it('is plain text without an action, and draws nothing for a missing trail', () => {
    const tree = render({...block, action: undefined}, {crumbs}, context());
    expect(tree.root.findAllByType(Pressable).every((step: any) => step.props.disabled)).toBe(true);
    const empty = render(block, {}, context());
    expect(empty.root.findAllByType(Pressable)).toEqual([]);
  });
});
