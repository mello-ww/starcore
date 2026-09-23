import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {ConnectScreen} from '../src/screens/ConnectScreen';

jest.mock('../src/servers/testConnection', () => ({
  normalizeServerUrl: (input: string) =>
    /^https?:\/\//i.test(input.trim()) ? input.trim() : `http://${input.trim()}`,
  testConnection: jest.fn(),
}));

import {testConnection} from '../src/servers/testConnection';

/**
 * ConnectScreen is now only ever reached as the "Add Server" step
 * (Settings > Servers > Add server - see navigation/MainTabs.tsx); the
 * first-launch case moved to navigation/OnboardingNavigator.tsx. This
 * covers that the Add Server flow itself is unaffected by that split, and
 * shares the same "don't silently accept an unreachable server" fix.
 */
describe('ConnectScreen ("Add Server" flow)', () => {
  beforeEach(() => {
    (testConnection as jest.Mock).mockReset();
  });

  it('shows a back button when onBack is provided, and it navigates back', () => {
    const onBack = jest.fn();
    const tree = renderer.create(<ConnectScreen onConnect={() => {}} onBack={onBack} />);

    act(() => tree.root.findByProps({testID: 'connect-back-button'}).props.onPress());

    expect(onBack).toHaveBeenCalled();
  });

  it('renders no back button when used for the very first server (no onBack given)', () => {
    const tree = renderer.create(<ConnectScreen onConnect={() => {}} />);

    expect(tree.root.findAllByProps({testID: 'connect-back-button'})).toHaveLength(0);
  });

  it('does not connect and shows an error when the server cannot be reached', async () => {
    (testConnection as jest.Mock).mockResolvedValue({ok: false, message: 'Could not reach StarCore.'});
    const onConnect = jest.fn();
    const tree = renderer.create(<ConnectScreen onConnect={onConnect} onBack={() => {}} />);

    act(() => tree.root.findByProps({testID: 'connect-url-input'}).props.onChangeText('10.0.0.5:9999'));
    await act(async () => {
      tree.root.findByProps({title: 'Continue'}).props.onPress();
    });

    expect(onConnect).not.toHaveBeenCalled();
    const texts = tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['Could not reach StarCore.']));
  });

  it('connects once verified, normalizing a bare address', async () => {
    (testConnection as jest.Mock).mockResolvedValue({ok: true, resolvedBaseUrl: 'http://192.168.1.30:8090'});
    const onConnect = jest.fn();
    const tree = renderer.create(<ConnectScreen onConnect={onConnect} onBack={() => {}} />);

    act(() => {
      tree.root.findByProps({testID: 'connect-name-input'}).props.onChangeText('Office');
      tree.root.findByProps({testID: 'connect-url-input'}).props.onChangeText('192.168.1.30:8090');
    });
    await act(async () => {
      tree.root.findByProps({title: 'Continue'}).props.onPress();
    });

    expect(onConnect).toHaveBeenCalledWith('Office', 'http://192.168.1.30:8090');
  });

  it('connects using the resolved address, not the typed one, when they differ (e.g. after a redirect)', async () => {
    (testConnection as jest.Mock).mockResolvedValue({
      ok: true,
      resolvedBaseUrl: 'https://starcore-panel.duckdns.org',
    });
    const onConnect = jest.fn();
    const tree = renderer.create(<ConnectScreen onConnect={onConnect} onBack={() => {}} />);

    act(() => tree.root.findByProps({testID: 'connect-url-input'}).props.onChangeText('starcore-panel.duckdns.org'));
    await act(async () => {
      tree.root.findByProps({title: 'Continue'}).props.onPress();
    });

    expect(onConnect).toHaveBeenCalledWith('', 'https://starcore-panel.duckdns.org');
  });

  it('resumes with the name/address already filled in, when given', () => {
    const tree = renderer.create(
      <ConnectScreen onConnect={() => {}} onBack={() => {}} initialName="Office" initialAddress="192.168.1.30:8090" />,
    );

    expect(tree.root.findByProps({testID: 'connect-name-input'}).props.value).toBe('Office');
    expect(tree.root.findByProps({testID: 'connect-url-input'}).props.value).toBe('192.168.1.30:8090');
  });
});
