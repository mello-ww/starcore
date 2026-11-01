import AsyncStorage from '@react-native-async-storage/async-storage';
import {ConnectClient} from '../src/music/connect';
import {activeLine, activeWords, lyricsTime} from '../src/music/lyrics';
import {deviceId, musicKeys} from '../src/music/storage';
import type {LyricLine} from '../src/music/types';

function handlers() {
  return {onCommand: jest.fn(), onRemoteState: jest.fn(), onDevicesChanged: jest.fn()};
}

describe('ConnectClient', () => {
  it('only runs commands addressed to this device', () => {
    const events = handlers();
    const client = new ConnectClient({} as any, 'mobile-device-1', 'Phone', events);
    client.dispatch({type: 'command', seq: 1, target: 'web-device-1', command: 'pause'});
    client.dispatch({type: 'command', seq: 2, target: 'mobile-device-1', command: 'next', arguments: {}});
    client.dispatch({type: 'state', seq: 3, device: 'web-device-1', state: {playing: true}});
    client.dispatch({type: 'state', seq: 4, device: 'mobile-device-1', state: {playing: true}});
    expect(events.onCommand).toHaveBeenCalledTimes(1);
    expect(events.onCommand).toHaveBeenCalledWith('next', {}, expect.anything());
    expect(events.onRemoteState).toHaveBeenCalledTimes(1);
  });

  it('registers, then long-polls from the cursor, and backs off after a failure', async () => {
    const events = handlers();
    const sleeps: number[] = [];
    let polls = 0;
    const api = {
      registerDevice: jest.fn(async () => ({cursor: 5})),
      events: jest.fn(async (_device: string, since: number) => {
        polls++;
        if (polls === 1) {
          expect(since).toBe(5);
          return {events: [{type: 'command', seq: 6, target: 'mobile-device-1', command: 'play'}], cursor: 6};
        }
        if (polls === 2) {
          expect(since).toBe(6);
          throw new Error('offline');
        }
        client.stop();
        return {events: [], cursor: 6};
      }),
    };
    const client = new ConnectClient(api as any, 'mobile-device-1', 'Phone', events, async ms => {
      sleeps.push(ms);
    });
    client.start();
    for (let i = 0; i < 30 && client.active; i++) {
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
    expect(api.registerDevice).toHaveBeenCalledWith('mobile-device-1', 'Phone');
    expect(events.onCommand).toHaveBeenCalledWith('play', {}, expect.anything());
    expect(sleeps[0]).toBe(2000);
    expect(client.active).toBe(false);
  });
});

describe('lyrics timing', () => {
  const lines: LyricLine[] = [
    {time: 0, text: 'one', words: [], translation: null},
    {time: 5000, text: 'two', words: [{time: 5000, text: 'two '}, {time: 5600, text: 'words'}], translation: 'deux'},
    {time: 9000, text: 'three', words: [], translation: null},
  ];

  it('finds the line being sung, and how far into its words', () => {
    expect(activeLine(lines, -100)).toBe(-1);
    expect(activeLine(lines, 4999)).toBe(0);
    expect(activeLine(lines, 5000)).toBe(1);
    expect(activeLine(lines, 20000)).toBe(2);
    expect(activeWords(lines[1], 5300)).toBe(1);
    expect(activeWords(lines[1], 5700)).toBe(2);
  });

  it('applies the manual offset', () => {
    expect(lyricsTime(5, 500)).toBe(4500);
    expect(lyricsTime(5, -500)).toBe(5500);
  });
});

describe('music storage', () => {
  beforeEach(() => AsyncStorage.clear());

  it('keeps one stable Connect device id per server', async () => {
    const first = await deviceId('server-a');
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(await deviceId('server-a')).toBe(first);
    expect(await deviceId('server-b')).not.toBe(first);
    expect(musicKeys.queue('server-a')).not.toBe(musicKeys.queue('server-b'));
  });
});
