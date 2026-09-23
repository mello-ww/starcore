import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ActivityIndicator, Text} from 'react-native';
import {SatelliteDetailScreen} from '../src/screens/SatelliteDetailScreen';
import {PrimaryButton} from '../src/components/PrimaryButton';

// Factory-mocked (not auto-mocked) - see satellitesListScreen.test.tsx's
// comment on the same line for why.
jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));
jest.mock('../src/satellites/api', () => {
  const mobileUi = jest.fn();
  const runAction = jest.fn();
  return {SatellitesApi: jest.fn().mockImplementation(() => ({mobileUi, runAction})), __mocks: {mobileUi, runAction}};
});

import {useAuth} from '../src/auth/AuthContext';
const {__mocks} = jest.requireMock('../src/satellites/api') as {__mocks: {mobileUi: jest.Mock; runAction: jest.Mock}};

const setOptions = jest.fn();
const navigation = {setOptions} as any;
const route = {params: {name: 'status'}} as any;

const screen = {
  title: 'Status',
  sections: [{type: 'card' as const, title: 'System', items: [{type: 'status' as const, label: 'CPU', value: '12%'}]}],
};

/**
 * Covers requirement 2: a satellite's mobile UI is fetched from
 * /api/satellites/<name>/mobile and rendered through the existing
 * DeclarativeScreen renderer - never a per-satellite hardcoded screen.
 */
describe('SatelliteDetailScreen', () => {
  beforeEach(() => {
    __mocks.mobileUi.mockReset();
    __mocks.runAction.mockReset();
    setOptions.mockReset();
    (useAuth as jest.Mock).mockReturnValue({client: {}});
  });

  function texts(tree: ReturnType<typeof renderer.create>) {
    return tree.root.findAllByType(Text).map((node: any) => node.props.children).flat().filter(Boolean);
  }

  it('shows a loading indicator before the mobile UI arrives', () => {
    __mocks.mobileUi.mockReturnValue(new Promise(() => {})); // never resolves
    const tree = renderer.create(<SatelliteDetailScreen navigation={navigation} route={route} />);

    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);
  });

  it('renders the declarative screen StarCore returns, via the shared renderer', async () => {
    __mocks.mobileUi.mockResolvedValue({screen});
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatelliteDetailScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['CPU', '12%']));
    expect(setOptions).toHaveBeenCalledWith({title: 'status'});
  });

  it('shows an error instead of a screen when the fetch fails', async () => {
    __mocks.mobileUi.mockRejectedValue(new Error('Could not load this Satellite.'));
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatelliteDetailScreen navigation={navigation} route={route} />);
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['Could not load this Satellite.']));
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('runs a button action through the shared satellites API and refreshes', async () => {
    const withButton = {
      title: 'Status',
      sections: [{type: 'card' as const, items: [{type: 'button' as const, label: 'Restart', action: {route: 'restart', method: 'POST' as const}}]}],
    };
    __mocks.mobileUi.mockResolvedValue({screen: withButton});
    __mocks.runAction.mockResolvedValue({});
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatelliteDetailScreen navigation={navigation} route={route} />);
    });

    await act(async () => {
      tree.root.findByType(PrimaryButton).props.onPress();
    });

    expect(__mocks.runAction).toHaveBeenCalledWith('status', {route: 'restart', method: 'POST'});
    expect(__mocks.mobileUi).toHaveBeenCalledTimes(2); // initial load + reload after the action
  });

  it('shows an error and keeps the screen visible if an action fails', async () => {
    const withButton = {
      title: 'Status',
      sections: [{type: 'card' as const, items: [{type: 'button' as const, label: 'Restart', action: {route: 'restart', method: 'POST' as const}}]}],
    };
    __mocks.mobileUi.mockResolvedValue({screen: withButton});
    __mocks.runAction.mockRejectedValue(new Error('That action failed.'));
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<SatelliteDetailScreen navigation={navigation} route={route} />);
    });

    await act(async () => {
      tree.root.findByType(PrimaryButton).props.onPress();
    });

    expect(texts(tree)).toEqual(expect.arrayContaining(['That action failed.', 'Restart']));
  });
});
