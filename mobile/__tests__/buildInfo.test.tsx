import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Clipboard, NativeModules, Text} from 'react-native';

jest.mock('../src/auth/AuthContext', () => ({useAuth: jest.fn()}));

import {useAuth} from '../src/auth/AuthContext';
import {AboutCard, VersionFootnote} from '../src/components/AboutCard';
import {appBuildInfo, buildInfoReport, commitLabel, parseEngineBuild} from '../src/platform/buildInfo';

const NATIVE = {
  version: '0.1.0-alpha.1',
  versionCode: 100101,
  channel: 'alpha',
  commit: 'abc1234',
  buildNumber: '67',
  dirty: false,
  buildDate: '2026-11-03',
  buildType: 'release',
};

const ENGINE_BUILD = {version: '0.1.0-alpha.1', channel: 'alpha', build: 66, commit: '59b971c', dirty: false, date: '2026-11-03T22:15:10+01:00'};

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props.testID === testID && n.type === Text);
  return ([] as unknown[]).concat(node.props.children).join('');
}

beforeEach(() => {
  NativeModules.StarCoreBuildInfo = {...NATIVE};
});

const mounted: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  // unmounting clears AboutCard's "Copied" timer before the test ends
  act(() => mounted.splice(0).forEach(tree => tree.unmount()));
  delete NativeModules.StarCoreBuildInfo;
});

describe('appBuildInfo', () => {
  it('reads what Gradle stamped into the build', () => {
    expect(appBuildInfo()).toEqual({...NATIVE, buildNumber: 67});
  });

  it('reports unknown rather than inventing values when the module is missing', () => {
    delete NativeModules.StarCoreBuildInfo;
    const info = appBuildInfo();
    expect(info.version).toBe('unknown');
    expect(info.commit).toBeNull();
    expect(info.buildNumber).toBeNull();
    expect(commitLabel(info.commit, info.dirty)).toBe('unknown');
  });

  it('treats an empty commit (no Git at build time) as unknown', () => {
    NativeModules.StarCoreBuildInfo = {...NATIVE, commit: '', buildNumber: ''};
    expect(appBuildInfo().commit).toBeNull();
    expect(appBuildInfo().buildNumber).toBeNull();
  });
});

describe('parseEngineBuild', () => {
  it('accepts the Engine status "build"', () => {
    expect(parseEngineBuild(ENGINE_BUILD)?.build).toBe(66);
  });

  it('returns null for an older Engine that reports nothing', () => {
    expect(parseEngineBuild(undefined)).toBeNull();
    expect(parseEngineBuild({commit: 'abc'})).toBeNull();
  });
});

describe('buildInfoReport', () => {
  it('lists the app and the Engine separately and nothing identifying', () => {
    const report = buildInfoReport(appBuildInfo(), parseEngineBuild({...ENGINE_BUILD, dirty: true}));
    expect(report).toContain('App: 0.1.0-alpha.1 (alpha, release)');
    expect(report).toContain('App commit: abc1234');
    expect(report).toContain('Engine: 0.1.0-alpha.1 (alpha)');
    expect(report).toContain('Engine commit: 59b971c + local changes');
    expect(report).toContain('Engine date: 2026-11-03');
    expect(report).not.toMatch(/https?:|token|password/i);
  });

  it('says when the Engine did not report a version', () => {
    expect(buildInfoReport(appBuildInfo(), null, 'unreachable')).toContain('Engine: unreachable');
  });
});

describe('AboutCard', () => {
  async function render(get: jest.Mock) {
    (useAuth as jest.Mock).mockReturnValue({client: {get}});
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AboutCard />);
    });
    mounted.push(tree);
    return tree;
  }

  it('shows the app build and the connected Engine build', async () => {
    const get = jest.fn().mockResolvedValue({status: 200, body: {build: ENGINE_BUILD}});
    const tree = await render(get);
    expect(get).toHaveBeenCalledWith('/api/status');
    expect(textOf(tree, 'about-app-version')).toBe('0.1.0-alpha.1');
    expect(textOf(tree, 'about-app-commit')).toBe('abc1234');
    expect(textOf(tree, 'about-engine-version')).toBe('0.1.0-alpha.1');
  });

  it('explains an Engine that does not report its version', async () => {
    const tree = await render(jest.fn().mockResolvedValue({status: 200, body: {}}));
    expect(textOf(tree, 'about-engine-missing')).toContain('older Engine');
  });

  it('copies the build report', async () => {
    const setString = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    const tree = await render(jest.fn().mockResolvedValue({status: 200, body: {build: ENGINE_BUILD}}));
    const button = tree.root.find(n => n.props.title === 'Copy build info' && typeof n.props.onPress === 'function');
    await act(async () => {
      button.props.onPress();
    });
    expect(setString).toHaveBeenCalledWith(expect.stringContaining('Engine build: 66'));
    setString.mockRestore();
  });
});

describe('VersionFootnote', () => {
  it('is a quiet version line', () => {
    const tree = renderer.create(<VersionFootnote />);
    mounted.push(tree);
    expect(textOf(tree, 'version-footnote')).toBe('StarCore 0.1.0-alpha.1 · build 67');
  });
});
