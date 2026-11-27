import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import type {UiBlock} from '../src/satellites/ui/contract';

// a form starts from its page's data and follows it while nothing in it was changed: the data
// can arrive after the form is first drawn, or come back new after a save
function context(runAction = jest.fn(async () => true)): BlockContext {
  return {
    developer: false,
    providers: {},
    runAction,
    readCapability: jest.fn(),
    forms: {},
    setEditing: jest.fn(),
    mediaSource: route => ({uri: `https://server.test/${route}`}),
    pageState: {},
    setPageState: jest.fn(),
  };
}

const form: UiBlock = {
  type: 'form',
  fields: [
    {
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      value: '$.mode',
      options: [
        {value: 'one', label: 'One'},
        {value: 'two', label: 'Two'},
        {value: 'three', label: 'Three'},
      ],
    },
  ],
  submit: {label: 'Save', action: {route: 'settings', method: 'POST', body: {mode: '$form.mode'}, then: 'refresh'}},
};

function draw(tree: ReturnType<typeof renderer.create> | null, data: Record<string, any>, shared: BlockContext) {
  const element = <UiBlocks blocks={[form]} scope={{data, page: data, params: {}, state: {}}} context={shared} />;
  if (tree) {
    act(() => tree.update(element));
    return tree;
  }
  let created!: ReturnType<typeof renderer.create>;
  act(() => {
    created = renderer.create(element);
  });
  return created;
}

const isOption = (node: any) => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function';

/** Each option once: the outermost of the nodes that carry its role. */
function options(tree: ReturnType<typeof renderer.create>) {
  return tree.root.findAll((node: any) => isOption(node) && !(node.parent && isOption(node.parent)));
}

function picked(tree: ReturnType<typeof renderer.create>): string[] {
  return options(tree)
    .filter((node: any) => node.props.accessibilityState?.selected)
    .map((node: any) => node.findAllByType(Text)[0].props.children);
}

describe('a form and its data', () => {
  it('shows the data that arrives after it is drawn', () => {
    const shared = context();
    const tree = draw(null, {}, shared);
    expect(picked(tree)).toEqual([]);
    draw(tree, {mode: 'two'}, shared);
    expect(picked(tree)).toEqual(['Two']);
  });

  it('shows what was saved once the page comes back', async () => {
    const shared = context();
    const tree = draw(null, {mode: 'one'}, shared);
    const two = options(tree)[1];
    act(() => two.props.onPress());
    const save = tree.root.findAll((node: any) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0];
    await act(async () => save.props.onPress());
    expect(shared.runAction).toHaveBeenCalledWith(form.submit?.action, expect.objectContaining({form: {mode: 'two'}}));
    draw(tree, {mode: 'two'}, shared);
    expect(picked(tree)).toEqual(['Two']);
  });

  it('keeps what the person changed when the data comes back', () => {
    const shared = context();
    const tree = draw(null, {mode: 'one'}, shared);
    const three = options(tree)[2];
    act(() => three.props.onPress());
    draw(tree, {mode: 'two'}, shared);
    expect(picked(tree)).toEqual(['Three']);
  });
});
