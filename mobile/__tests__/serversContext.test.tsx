import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ServersProvider, useServers} from '../src/servers/ServersContext';

type Ctx = ReturnType<typeof useServers>;

function Harness({onReady}: {onReady: (value: Ctx) => void}) {
  const value = useServers();
  onReady(value);
  return null;
}

async function setup() {
  let latest!: Ctx;
  await act(async () => {
    renderer.create(
      <ServersProvider>
        <Harness onReady={v => (latest = v)} />
      </ServersProvider>,
    );
    // flush the provider's async init effect (migrate + load from storage)
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    get current() {
      return latest;
    },
  };
}

/**
 * "Add a visible back button" (Add Server flow) hinges on `pendingAdd`/
 * `cancelPendingAdd` - the mechanism that lets a just-added, not-yet-signed-
 * into server be backed out of without leaving an orphaned duplicate
 * profile behind, and without losing track of what to switch back to. This
 * is the same mechanism for the first-launch wizard (no previous server)
 * and the Settings "Add Server" flow (a previous server exists), so both
 * are covered here directly against the context, rather than through the
 * navigators built on top of it.
 */
describe('ServersContext pendingAdd/cancelPendingAdd', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('has no pendingAdd before anything is added', async () => {
    const ctx = await setup();
    expect(ctx.current.pendingAdd).toBeNull();
  });

  it('records the new server as pendingAdd, with no previous server for the very first one', async () => {
    const ctx = await setup();

    await act(async () => {
      await ctx.current.addAndActivate('Home', 'http://192.168.1.20:8090');
    });

    expect(ctx.current.pendingAdd).toMatchObject({
      previousServerId: null,
      name: 'Home',
      baseUrl: 'http://192.168.1.20:8090',
    });
    expect(ctx.current.activeServer?.name).toBe('Home');
  });

  it('cancelling the very first add leaves no active server, ready to resume onboarding', async () => {
    const ctx = await setup();
    await act(async () => {
      await ctx.current.addAndActivate('Home', 'http://192.168.1.20:8090');
    });

    let resumed: {name: string; address: string} | null = null;
    await act(async () => {
      resumed = await ctx.current.cancelPendingAdd();
    });

    expect(resumed).toEqual({name: 'Home', address: 'http://192.168.1.20:8090'});
    expect(ctx.current.activeServer).toBeNull();
    expect(ctx.current.servers).toEqual([]); // not left behind as an orphaned profile
    expect(ctx.current.pendingAdd).toBeNull();
  });

  it('records the previous server, and cancelling a second add switches back to it', async () => {
    const ctx = await setup();
    await act(async () => {
      await ctx.current.addAndActivate('Home', 'http://192.168.1.20:8090');
    });
    await act(async () => {
      await ctx.current.clearPendingAdd(); // "Home" is now signed in, same as a real login
    });
    const homeId = ctx.current.activeServer!.id;

    await act(async () => {
      await ctx.current.addAndActivate('Office', 'http://10.0.0.5:8090');
    });

    expect(ctx.current.pendingAdd).toMatchObject({previousServerId: homeId, name: 'Office'});
    expect(ctx.current.activeServer?.name).toBe('Office');

    let resumed: {name: string; address: string} | null = null;
    await act(async () => {
      resumed = await ctx.current.cancelPendingAdd();
    });

    expect(resumed).toEqual({name: 'Office', address: 'http://10.0.0.5:8090'});
    expect(ctx.current.activeServer?.id).toBe(homeId); // back to the server that was active before
    expect(ctx.current.servers.map(s => s.name)).toEqual(['Home']); // Office was removed, not left orphaned
    expect(ctx.current.pendingAdd).toBeNull();
  });

  it('clearPendingAdd leaves the server in place - a real sign-in, not a cancel', async () => {
    const ctx = await setup();
    await act(async () => {
      await ctx.current.addAndActivate('Home', 'http://192.168.1.20:8090');
    });

    act(() => {
      ctx.current.clearPendingAdd();
    });

    expect(ctx.current.pendingAdd).toBeNull();
    expect(ctx.current.activeServer?.name).toBe('Home');
    expect(ctx.current.servers).toHaveLength(1);
  });
});
