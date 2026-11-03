import React from 'react';
import {ScrollView, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {snapshot, history} from './statusFixtures';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
// one client for the whole test, as AuthContext gives the app (a new one per
// render would rebuild the API and restart polling on every render)
const mockClient = {};
jest.mock('../src/auth/AuthContext', () => ({useAuth: () => ({client: mockClient})}));
jest.mock('../src/status/api', () => {
  const actual = jest.requireActual('../src/status/api');
  const metrics = jest.fn();
  const historyCall = jest.fn();
  return {
    ...actual,
    StatusApi: jest.fn().mockImplementation(() => ({metrics, history: historyCall})),
    __mocks: {metrics, history: historyCall},
  };
});

import {StatusHomeScreen} from '../src/status/StatusHomeScreen';
const {__mocks} = jest.requireMock('../src/status/api') as {__mocks: {metrics: jest.Mock; history: jest.Mock}};

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
}

const mounted: Tree[] = [];

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(<StatusHomeScreen />);
  });
  mounted.push(tree);
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

async function open(tree: Tree, key: string) {
  await act(async () => tree.root.findByProps({testID: `status-tab-${key}`}).props.onPress());
  await act(async () => {
    await Promise.resolve();
  });
}

describe('StatusHomeScreen', () => {
  beforeEach(() => {
    __mocks.metrics.mockReset().mockResolvedValue(snapshot());
    __mocks.history.mockReset().mockResolvedValue(history());
  });

  // the screen polls on real timers; unmounting stops them so Jest can exit
  afterEach(() => {
    while (mounted.length) {
      const tree = mounted.pop()!;
      act(() => tree.unmount());
    }
  });

  it('opens on the overview: health, warnings and real KPIs', async () => {
    const tree = await render();
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['atlas', 'Warning', 'D:\\ is almost full', '30%', '75%', '90.4%', '2/3', '7d 21h']));
    expect(shown).toContain('24.0 GiB of 31.9 GiB');
    expect(shown).toContain('↓ 15 kb/s');
    expect(shown.some(text => text.startsWith('Sampled every 5s'))).toBe(true);
    expect(__mocks.history).toHaveBeenCalledWith('1h', ['cpu', 'memory'], 60);
  });

  it('shows hardware, and why a reading is missing instead of a number', async () => {
    const tree = await render();
    await open(tree, 'hardware');
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['Intel(R) Core(TM) i5-10600KF CPU @ 4.10GHz', '2 cores · 4 threads', '4.50 GHz']));
    expect(shown).toContain('base 4.10 GHz');
    expect(shown).toContain('Windows has no load average');
    expect(shown).toContain('Windows exposes no CPU temperature without vendor tools or administrator WMI access');
    expect(shown).toContain('179.2 GiB free of 1.8 TiB · NTFS · fixed');
    expect(shown).toContain('Windows 11 Pro');
  });

  it('shows network interfaces with bit rates, link speed, totals and errors', async () => {
    const tree = await render();
    await open(tree, 'network');
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['Ethernet 2', 'Up', 'Ethernet · 2.5 Gb/s', 'Wi-Fi', 'Down']));
    expect(shown).toContain('71.0 GiB received · 20.1 GiB sent');
    expect(shown).toContain('0 errors · 587 dropped');
  });

  it('shows services: the engine, satellite errors, dependencies and components', async () => {
    const tree = await render();
    await open(tree, 'services');
    const shown = texts(tree);
    expect(shown).toContain('StarCore is running');
    expect(shown).toContain("start hook of satellite 'Photo' failed: port in use");
    expect(shown).toContain('Part of Photo');
    expect(shown).toEqual(expect.arrayContaining(['Installed', 'Not installed']));
  });

  it('shows history charts for recorded series and explains the missing ones', async () => {
    const tree = await render();
    await open(tree, 'history');
    expect(__mocks.history).toHaveBeenLastCalledWith('24h', undefined, 60);
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['CPU · LAST 24 HOURS', 'NETWORK', 'Download', 'Upload', 'NOT RECORDED HERE']));
    expect(shown).toContain('Windows has no load average');
    await act(async () => tree.root.findByProps({testID: 'history-period-7d'}).props.onPress());
    expect(__mocks.history).toHaveBeenLastCalledWith('7d', undefined, 60);
  });

  it('says so when nothing has been recorded because sampling is off', async () => {
    __mocks.history.mockResolvedValue(history({sampling: false, series: {cpu: {unit: '%', points: []}}}));
    const tree = await render();
    await open(tree, 'history');
    expect(texts(tree).some(text => text.includes("History is kept while the Status service runs"))).toBe(true);
  });

  it('shows an error with a retry when Status cannot be reached', async () => {
    __mocks.metrics.mockRejectedValueOnce(new Error('Could not reach this StarCore server.'));
    const tree = await render();
    expect(texts(tree)).toEqual(expect.arrayContaining(['Status is unavailable', 'Could not reach this StarCore server.', 'Try again']));
    await act(async () => tree.root.findByProps({testID: 'status-retry'}).props.onPress());
    await act(async () => {
      await Promise.resolve();
    });
    expect(texts(tree)).toContain('atlas');
  });

  it('keeps the last reading on screen and says it is offline when a refresh fails', async () => {
    const tree = await render();
    __mocks.metrics.mockRejectedValue(new Error('Network request failed'));
    const scroll = tree.root.findByType(ScrollView);
    await act(async () => scroll.props.refreshControl.props.onRefresh());
    const shown = texts(tree);
    expect(shown).toContain('Offline');
    expect(shown.some(text => text.includes('Network request failed'))).toBe(true);
    expect(shown).toContain('D:\\ is almost full');
  });

  it('copes with a server that reports almost nothing', async () => {
    __mocks.metrics.mockResolvedValue(
      snapshot({
        cpu: null, memory: null, storage: null, network: null, system: null,
        unsupported: {'cpu.percent': 'FreeBSD is not supported by the Status satellite yet', network: 'no counters'},
        health: {state: 'ok', warnings: []},
      }),
    );
    const tree = await render();
    expect(texts(tree)).toContain('No warnings. Every reading is within its normal range.');
    await open(tree, 'hardware');
    expect(texts(tree)).toContain('Not available: FreeBSD is not supported by the Status satellite yet');
    await open(tree, 'network');
    expect(texts(tree)).toContain('Not available: no counters');
  });
});
