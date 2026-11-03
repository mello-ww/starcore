import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import {DeveloperModeButton} from '../src/developer/DeveloperModeButton';
import {
  DeveloperModeProvider,
  storageKey,
  useDeveloperMode,
  visibleToDeveloper,
} from '../src/developer/DeveloperModeContext';
import {DeclarativeScreen} from '../src/satellites/DeclarativeScreen';
import type {UiScreen} from '../src/satellites/types';

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root
    .findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat(3)
    .filter((value: unknown) => typeof value === 'string');
}

let latest: ReturnType<typeof useDeveloperMode> | null = null;
function Probe() {
  latest = useDeveloperMode();
  return <Text>{latest.enabled ? 'developer on' : 'developer off'}</Text>;
}

async function mount(serverId: string, children: React.ReactNode = <Probe />): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(<DeveloperModeProvider serverId={serverId}>{children}</DeveloperModeProvider>);
  });
  return tree;
}

const screen: UiScreen = {
  title: 'Status',
  sections: [
    {
      type: 'card',
      items: [
        {type: 'status', label: 'Health', value: 'Healthy'},
        {type: 'status', label: 'Python', value: '3.13.0', developer: true},
      ],
    },
    {type: 'card', title: 'Collector', developer: true, items: [{type: 'text', value: 'sampling every 5 s'}]},
  ],
};

beforeEach(async () => {
  latest = null;
  await AsyncStorage.clear();
});

describe('Developer Mode', () => {
  it('is off by default', async () => {
    const tree = await mount('server-a');
    expect(texts(tree)).toContain('developer off');
  });

  it('is remembered per server on this device', async () => {
    const first = await mount('server-a');
    await act(async () => latest!.setEnabled(true));
    expect(texts(first)).toContain('developer on');
    expect(await AsyncStorage.getItem(storageKey('server-a'))).toBe('on');
    await act(async () => first.unmount());

    const again = await mount('server-a');
    expect(texts(again)).toContain('developer on');
    await act(async () => again.unmount());

    const other = await mount('server-b');
    expect(texts(other)).toContain('developer off');
  });

  it('never carries one server choice over to the next when switching', async () => {
    await AsyncStorage.setItem(storageKey('server-a'), 'on');
    const tree = await mount('server-a');
    expect(texts(tree)).toContain('developer on');
    await act(async () => {
      tree.update(
        <DeveloperModeProvider serverId="server-b">
          <Probe />
        </DeveloperModeProvider>,
      );
    });
    expect(texts(tree)).toContain('developer off');
  });

  it('is switched from the top-right terminal button', async () => {
    const tree = await mount('server-a', (
      <>
        <DeveloperModeButton />
        <Probe />
      </>
    ));
    const button = tree.root.findAll((node: any) => node.props.testID === 'developer-mode-button' && node.props.onPress)[0];
    expect(button.props.accessibilityState).toEqual({checked: false});
    await act(async () => button.props.onPress());
    expect(texts(tree)).toContain('developer on');
    const pressed = tree.root.findAll((node: any) => node.props.testID === 'developer-mode-button' && node.props.onPress)[0];
    expect(pressed.props.accessibilityState).toEqual({checked: true});
  });

  it('filters anything a Satellite marked developer-only', () => {
    const entries = [{name: 'everyday'}, {name: 'advanced', developer: true}];
    expect(visibleToDeveloper(entries, false).map(entry => entry.name)).toEqual(['everyday']);
    expect(visibleToDeveloper(entries, true).map(entry => entry.name)).toEqual(['everyday', 'advanced']);
  });

  it('hides developer sections and items of a declarative Satellite screen until it is on', async () => {
    const tree = await mount('server-a', (
      <>
        <DeclarativeScreen screen={screen} onAction={() => {}} />
        <Probe />
      </>
    ));
    expect(texts(tree)).toContain('Health');
    expect(texts(tree)).not.toContain('Python');
    expect(texts(tree)).not.toContain('Collector');

    await act(async () => latest!.setEnabled(true));
    expect(texts(tree)).toContain('Python');
    expect(texts(tree)).toContain('Collector');
  });
});
