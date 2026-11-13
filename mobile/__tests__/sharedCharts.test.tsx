import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {ColumnChart, buildSlots, niceMax} from '../src/components/charts';

type Tree = ReturnType<typeof renderer.create>;

function texts(tree: Tree): string[] {
  return tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
}

// a day of readings every 1440 s with five columns missing: a gap
const FROM = 1_730_000_000;
const RESOLUTION = 1440;
const TO = FROM + 60 * RESOLUTION;
function cpuPoints(): [number, number, number][] {
  return Array.from({length: 60}, (_, index) => index)
    .filter(index => index < 20 || index >= 25)
    .map(index => [FROM + index * RESOLUTION, 30 + (index % 5), 40] as [number, number, number]);
}
const percent = (value: number | null | undefined) => (value == null ? '—' : value === 0 ? '0' : `${Math.round(value)}%`);

describe('buildSlots', () => {
  it('lays points on a fixed time grid and leaves a gap where there were no readings', () => {
    const slots = buildSlots([{key: 'cpu', label: 'CPU', color: '#fff', points: cpuPoints()}], FROM, TO, RESOLUTION);
    expect(slots).toHaveLength(60);
    expect(slots.slice(20, 25).every(slot => slot.values[0] === null)).toBe(true);
    expect(slots[19].values[0]).toBe(34);
    expect(slots[25].values[0]).toBe(30);
    expect(slots[0].peaks[0]).toBe(40);
  });

  it('keeps each series in its own column and drops points outside the range', () => {
    const slots = buildSlots(
      [
        {key: 'net_rx', label: 'Download', color: '#fff', points: [[100, 10, 20], [-50, 99, 99], [900, 5, 5]]},
        {key: 'net_tx', label: 'Upload', color: '#888', points: [[100, 1, 2]]},
      ],
      100,
      400,
      100,
    );
    expect(slots).toHaveLength(3);
    expect(slots[0].values).toEqual([10, 1]);
    expect(slots[1].values).toEqual([null, null]);
  });

  it('spans the whole period even when there are more points than columns', () => {
    // 24 hours at 240 s per point is 360 points: more than the column cap, so
    // columns widen - the newest readings must still land in the last ones
    const day = 86400;
    const points: [number, number, number][] = [[day - 600, 40, 50], [day - 240, 60, 70]];
    const slots = buildSlots([{key: 'cpu', label: 'CPU', color: '#fff', points}], 0, day, 240);
    expect(slots.length).toBeLessThanOrEqual(240);
    expect(slots[slots.length - 1].start + (slots[1].start - slots[0].start)).toBeGreaterThanOrEqual(day);
    expect(slots.filter(slot => slot.values[0] !== null).length).toBeGreaterThan(0);
    expect(slots[slots.length - 1].values[0]).not.toBeNull();
  });

  it('averages two points that land in the same column', () => {
    const slots = buildSlots([{key: 'cpu', label: 'CPU', color: '#fff', points: [[0, 10, 20], [50, 30, 40]]}], 0, 100, 100);
    expect(slots[0].values[0]).toBe(20);
    expect(slots[0].peaks[0]).toBe(40);
  });
});

describe('niceMax', () => {
  it('uses 100% for usage and round numbers otherwise', () => {
    expect(niceMax(12, 'percent')).toBe(100);
    expect(niceMax(3.2, 'plain')).toBe(5);
    expect(niceMax(3 * 1024 * 1024, 'bytes')).toBe(5 * 1024 * 1024);
    expect(niceMax(1_000_000, 'bits')).toBe(1_250_000); // 8 Mb/s -> a 10 Mb/s axis
  });
});

describe('ColumnChart', () => {
  function render(): Tree {
    let tree!: Tree;
    act(() => {
      tree = renderer.create(
        <ColumnChart
          title="CPU"
          from={FROM}
          to={TO}
          resolution={RESOLUTION}
          scale="percent"
          format={percent}
          timeLabel={() => '12:00'}
          series={[{key: 'cpu', label: 'CPU', color: '#ee444b', points: cpuPoints()}]}
        />,
      );
    });
    return tree;
  }

  it('draws the gap as empty columns and labels the axis', () => {
    const tree = render();
    expect(tree.root.findAllByProps({testID: 'chart-gap'}, {deep: false}).length).toBe(5);
    expect(tree.root.findAllByProps({testID: 'chart-slot'}, {deep: false}).length).toBe(55);
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['100%', '50%', '0', 'Now']));
    expect(shown.some(text => text.startsWith('CPU avg'))).toBe(true);
  });

  it('reads out the column under the finger, and steps with accessibility actions', () => {
    const tree = render();
    const plot = tree.root.findByProps({testID: 'chart-plot'});
    act(() => plot.props.onLayout({nativeEvent: {layout: {width: 600, height: 120}}}));
    act(() => plot.props.onResponderGrant({nativeEvent: {locationX: 5}}));
    expect(texts(tree).find(text => text.includes('peak'))).toMatch(/CPU 30% \(peak 40%\)/);
    act(() => plot.props.onAccessibilityAction({nativeEvent: {actionName: 'increment'}}));
    expect(tree.root.findByProps({testID: 'chart-readout'}).props.children).toMatch(/CPU 31%/);
    act(() => plot.props.onResponderMove({nativeEvent: {locationX: 215}})); // slot 21: no reading
    expect(tree.root.findByProps({testID: 'chart-readout'}).props.children).toMatch(/CPU no reading/);
  });

  it('lists every value behind the "Show values" toggle', () => {
    const tree = render();
    expect(tree.root.findAllByProps({testID: 'chart-table'})).toHaveLength(0);
    act(() => tree.root.findByProps({accessibilityLabel: 'Show CPU values'}).props.onPress());
    const table = tree.root.findByProps({testID: 'chart-table'});
    // one row per column with a reading - the five-column gap has none
    expect(table.findAllByType(Text).length).toBe(55 * 2);
  });
});
