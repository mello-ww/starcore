import {backgroundTimers} from '../src/media/native';
import {PlayerController} from '../src/media/player';
import {fakeEffects, makeTracks, manualTimers, preferences, testLibrary} from './audioFakes';

function setup(overrides: Partial<ConstructorParameters<typeof PlayerController>[0]> = {}) {
  const timers = manualTimers();
  const library = testLibrary();
  const api = {
    path: library.path,
    streamPath: library.streamPath.bind(library),
    playback: jest.fn(async (id: string, quality: string) => ({
      track: {} as any,
      plan: {delivery: quality === 'original' ? 'original' : 'transcode', format: 'flac', codec: 'flac', bitrate: null, lossless: true, reason: null},
      stream: `stream/${id}?quality=${quality}`,
      gain: {db: -6, source: 'album', peak: 0.9},
      normalize: false,
    })) as any,
    recordPlay: jest.fn(async () => ({})),
    saveQueue: jest.fn(async () => ({})),
    publishState: jest.fn(async () => ({})),
    radio: jest.fn(async () => ({tracks: makeTracks(3, 'r')})) as any,
    command: jest.fn(async () => ({})),
  };
  const effects = fakeEffects();
  const saveLocal = jest.fn();
  let prefs = {...preferences};
  const player = new PlayerController({
    api,
    baseUrl: 'https://music.test',
    token: () => 'secret-token',
    deviceId: () => 'mobile-device-1',
    downloads: null,
    effects,
    network: effects.getNetworkType,
    preferences: () => prefs,
    saveLocal,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  const seeks: number[] = [];
  player.seeker = seconds => seeks.push(seconds);
  return {player, api, effects, saveLocal, timers, seeks, setPrefs: (next: any) => (prefs = {...prefs, ...next})};
}

describe('PlayerController', () => {
  const tracks = makeTracks(3);

  it('streams the original on Wi-Fi with the session in a header, never the URL', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0, 'album:ab01ab01ab01ab01');
    expect(player.state.playing).toBe(true);
    expect(player.state.source?.uri).toBe(`https://music.test/api/satellites/music/stream/${tracks[0].id}?quality=original`);
    expect(player.state.source?.uri).not.toContain('secret-token');
    expect(player.state.source?.headers).toEqual({Authorization: 'Bearer secret-token'});
  });

  it('uses the cellular quality on a cellular network', async () => {
    const {player, effects} = setup();
    effects.getNetworkType.mockResolvedValue('cellular' as any);
    await player.playTracks(tracks, 0);
    expect(player.state.source?.uri).toContain('quality=normal');
    expect(player.state.plan?.delivery).toBe('transcode');
  });

  it('plays a downloaded copy from the phone instead of streaming', async () => {
    const downloads = {localUri: jest.fn(() => 'file:///data/music/srv/tracks/x.audio'), markPlayed: jest.fn()} as any;
    const {player, api} = setup({downloads});
    await player.playTracks(tracks, 0);
    expect(player.state.source).toEqual({uri: 'file:///data/music/srv/tracks/x.audio', local: true, quality: 'original'});
    expect(api.playback).not.toHaveBeenCalled();
    expect(downloads.markPlayed).toHaveBeenCalledWith(tracks[0].id);
  });

  it('applies ReplayGain attenuation through the volume and never boosts past it', async () => {
    const {player, effects} = setup();
    await player.playTracks(tracks, 0);
    expect(player.state.volume).toBeCloseTo(Math.pow(10, -6 / 20));
    expect(effects.setLoudness).toHaveBeenLastCalledWith(0);
  });

  it('advances on end and reports the seconds actually listened', async () => {
    const {player, api} = setup();
    await player.playTracks(tracks, 0, 'album:ab01ab01ab01ab01');
    player.onLoad(200);
    for (let second = 0; second <= 120; second += 1) {
      player.onProgress(second);
    }
    await player.onEnd();
    expect(api.recordPlay).toHaveBeenCalledWith(tracks[0].id, 120, 'mobile-device-1', 'album:ab01ab01ab01ab01');
    expect(player.state.track?.id).toBe(tracks[1].id);
  });

  it('does not count a seek as listening time', async () => {
    const {player, api} = setup();
    await player.playTracks(tracks, 0);
    player.onProgress(0);
    player.onProgress(1);
    player.seek(150);
    player.onProgress(151);
    await player.next();
    expect(api.recordPlay).toHaveBeenCalledWith(tracks[0].id, 2, expect.any(String), null);
  });

  it('repeats one track by seeking back instead of reloading', async () => {
    const {player, seeks} = setup();
    await player.playTracks(tracks, 1);
    player.cycleRepeat();
    player.cycleRepeat();
    expect(player.state.queue.repeat).toBe('one');
    await player.onEnd();
    expect(player.state.track?.id).toBe(tracks[1].id);
    expect(seeks).toContain(0);
  });

  it('stops at the end of the queue, or keeps going with radio when autoplay is on', async () => {
    const {player, api, setPrefs} = setup();
    await player.playTracks(tracks, 2);
    await player.onEnd();
    expect(player.state.playing).toBe(false);

    setPrefs({queue_end: 'autoplay'});
    await player.playTracks(tracks, 2);
    player.onLoad(200);
    await player.onEnd();
    expect(api.radio).toHaveBeenCalledWith('track', tracks[2].id);
    expect(player.state.track?.title).toBe('Song r0');
    expect(player.state.playing).toBe(true);
  });

  it('restarts the song on previous after three seconds, otherwise goes back', async () => {
    const {player, seeks} = setup();
    await player.playTracks(tracks, 1);
    player.onProgress(10);
    await player.previous();
    expect(seeks).toContain(0);
    expect(player.state.track?.id).toBe(tracks[1].id);
    player.onProgress(1);
    await player.previous();
    expect(player.state.track?.id).toBe(tracks[0].id);
  });

  it('pauses on an interruption (a call, headphones unplugged) and saves at once', async () => {
    const {player, saveLocal} = setup();
    await player.playTracks(tracks, 0);
    saveLocal.mockClear();
    player.onInterrupted();
    expect(player.state.playing).toBe(false);
    expect(saveLocal).toHaveBeenCalled();
  });

  it('follows a pause and a resume made on the lock screen or a headset', async () => {
    const {player, saveLocal} = setup();
    await player.playTracks(tracks, 0);
    player.onLoad(200);
    player.onBuffer(false);
    player.onProgress(42);
    saveLocal.mockClear();

    player.onNativePlaying(false, false);
    // Media3 reports the stop before the end or buffering that may explain it: only the native
    // player's report that it is still ready makes it a pause
    expect(player.state.playing).toBe(true);
    player.onNativeReady();
    expect(player.state.playing).toBe(false);
    expect(player.state.position).toBe(42);
    expect(saveLocal).toHaveBeenCalled();

    player.onNativePlaying(true, false);
    expect(player.state.playing).toBe(true);
  });

  it('does not take loading, seeking or the end of a track for a pause', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 1);
    player.onNativePlaying(false, false); // still loading
    expect(player.state.playing).toBe(true);

    player.onLoad(200);
    player.onBuffer(false);
    player.onNativePlaying(false, true); // seeking
    expect(player.state.playing).toBe(true);

    player.cycleRepeat();
    player.cycleRepeat();
    await player.onEnd();
    player.onNativePlaying(false, false); // the track ended, repeat one starts it again
    expect(player.state.playing).toBe(true);
  });

  // The order below is what react-native-video delivers on a real device: Media3's
  // onIsPlayingChanged(false) comes before the onEvents that carry the end, the buffering or the
  // ready state which explain it.
  it('plays into the next track when the native player reports the stop before the end', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0);
    player.onNativePlaying(true, false);
    player.onNativeReady();
    player.onBuffer(false);
    player.onLoad(25);
    player.onProgress(24);
    const asked: boolean[] = [];
    player.subscribe(state => asked.push(state.playing));

    player.onNativePlaying(false, false);
    await player.onEnd();
    expect(player.state.track?.id).toBe(tracks[1].id);
    expect(player.state.playing).toBe(true);

    player.onBuffer(true);
    player.onNativePlaying(true, false);
    player.onNativeReady();
    player.onBuffer(false);
    player.onLoad(25);
    expect(player.state.track?.id).toBe(tracks[1].id);
    // a pause in between would toggle play-when-ready on the ended native player, which reports
    // the end again and skips a track
    expect(asked).not.toContain(false);
  });

  it('ignores the end the native player repeats while it sits at the end of a track', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0);
    player.onLoad(25);
    await player.onEnd();
    // react-native-video reports the end again whenever play-when-ready changes on an ended player
    await player.onEnd();
    expect(player.state.track?.id).toBe(tracks[1].id);

    player.onLoad(25);
    await player.onEnd();
    expect(player.state.track?.id).toBe(tracks[2].id);
  });

  it('does not take the stop of a source change for a pause', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 2);
    player.onLoad(25);
    await player.onEnd(); // the queue ends: paused at the start of its last track
    expect(player.state.playing).toBe(false);

    await player.playTracks(tracks, 0);
    const asked: boolean[] = [];
    player.subscribe(state => asked.push(state.playing));
    // the old track resumes for a moment, and its progress clears the buffering flag
    player.onNativePlaying(true, false);
    player.onNativeReady();
    player.onProgress(1);
    // then the native player switches to the new source
    player.onNativePlaying(false, false);
    player.onBuffer(true);
    player.onNativePlaying(true, false);
    player.onNativeReady();
    player.onBuffer(false);
    player.onLoad(25);
    expect(player.state.track?.id).toBe(tracks[0].id);
    // a pause in between would leave the new track loaded but paused at 0:00
    expect(asked).not.toContain(false);
  });

  it('leaves the state alone while it controls another device', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0);
    player.onLoad(200);
    player.onBuffer(false);
    (player as any).state = {...player.state, remote: {deviceId: 'web-1'}};
    player.onNativePlaying(false, false);
    expect(player.state.playing).toBe(true);
  });

  it('stops after the current song with the end-of-track sleep timer', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0);
    player.setSleep('end');
    await player.onEnd();
    expect(player.state.playing).toBe(false);
    expect(player.state.track?.id).toBe(tracks[1].id);
    expect(player.state.sleepAtEnd).toBe(false);
  });

  it('pauses when a minutes sleep timer fires', async () => {
    const {player, timers} = setup();
    await player.playTracks(tracks, 0);
    player.setSleep(15);
    expect(player.state.sleepAt).not.toBeNull();
    await timers.runAll(ms => ms === 15 * 60_000);
    expect(player.state.playing).toBe(false);
  });

  it('retries a failed stream with backoff, then falls back to the original quality', async () => {
    const {player, effects, timers} = setup();
    effects.getNetworkType.mockResolvedValue('cellular' as any);
    await player.playTracks(tracks, 0);
    expect(player.state.source?.quality).toBe('normal');
    const key = player.state.sourceKey;
    player.onError('network');
    await timers.runAll(ms => ms === 1000);
    expect(player.state.source?.quality).toBe('original');
    expect(player.state.sourceKey).toBe(key + 1);
    player.onError('again');
    await timers.runAll();
    player.onError('again');
    await timers.runAll();
    player.onError('gave up');
    expect(player.state.error).toBe('gave up');
    expect(player.state.playing).toBe(false);
  });

  it('saves the queue locally and to the server for this device', async () => {
    const {player, api, saveLocal, timers} = setup();
    await player.playTracks(tracks, 1);
    await timers.runAll();
    expect(saveLocal).toHaveBeenCalledWith(expect.objectContaining({position: 1, seconds: 0}));
    expect(api.saveQueue).toHaveBeenCalledWith('mobile-device-1', expect.objectContaining({
      queue: tracks.map(track => track.id), index: 1, playing: true}), 'StarCore Mobile');
  });

  it('restores a saved queue paused, at the saved position', async () => {
    const {player, seeks} = setup();
    player.restore({tracks, order: [0, 1, 2], position: 2, shuffle: false, repeat: 'all', seconds: 42, context: null});
    await Promise.resolve();
    await Promise.resolve();
    expect(player.state.track?.id).toBe(tracks[2].id);
    expect(player.state.playing).toBe(false);
    player.onLoad(200);
    expect(seeks).toContain(42);
  });

  it('takes over playback from another device with queue, position, shuffle and repeat', async () => {
    const {player, seeks} = setup();
    await player.handleCommand('transfer_in', {
      state: {queue: tracks.map(track => track.id), index: 2, order: [2, 0, 1], position: 61.5, playing: true,
        shuffle: true, repeat: 'all', volume: 1, speed: 1, context: 'playlist:abcdef0123456789'},
    }, async ids => tracks.filter(track => ids.includes(track.id)));
    expect(player.state.track?.id).toBe(tracks[2].id);
    expect(player.state.queue.shuffle).toBe(true);
    expect(player.state.queue.repeat).toBe('all');
    expect(player.state.playing).toBe(true);
    player.onLoad(200);
    expect(seeks).toContain(61.5);
  });

  it('obeys remote commands and pauses when playback moves elsewhere', async () => {
    const {player} = setup();
    await player.playTracks(tracks, 0);
    await player.handleCommand('next', {}, async () => []);
    expect(player.state.track?.id).toBe(tracks[1].id);
    await player.handleCommand('pause', {transferred: true}, async () => []);
    expect(player.state.playing).toBe(false);
    await player.handleCommand('shuffle', {on: true}, async () => []);
    expect(player.state.queue.shuffle).toBe(true);
  });

  it('sends transport to the remote device in remote-control mode', async () => {
    const {player, api} = setup();
    await player.playTracks(tracks, 0);
    player.setRemote({device: 'web-device-1', name: 'Mission Control', state: {playing: true}});
    player.toggle();
    await player.next();
    player.seek(30);
    expect(api.command).toHaveBeenCalledWith('mobile-device-1', 'web-device-1', 'pause', {});
    expect(api.command).toHaveBeenCalledWith('mobile-device-1', 'web-device-1', 'next', {});
    expect(api.command).toHaveBeenCalledWith('mobile-device-1', 'web-device-1', 'seek', {position: 30});
  });

  it('applies the equalizer, bass boost and pitch on the real player when a track loads', async () => {
    const {player, effects, setPrefs} = setup();
    setPrefs({equalizer: {enabled: true, preset: 'bass', bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], preamp: -2}, bass_boost: 4, pitch: 2});
    await player.playTracks(tracks, 0);
    player.onLoad(200);
    expect(effects.setEqualizer).toHaveBeenCalledWith(true, [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], -2);
    expect(effects.setBassBoost).toHaveBeenCalledWith(4);
    expect(effects.setPlaybackParameters).toHaveBeenCalledWith(1, 2);
    expect(effects.setNormalize).toHaveBeenLastCalledWith(false);
  });

  it('normalizes the volume on the real player when the preference says so, and stops when it no longer does', async () => {
    const {player, effects, setPrefs} = setup();
    setPrefs({normalize: true});
    await player.playTracks(tracks, 0);
    player.onLoad(200);
    expect(effects.setNormalize).toHaveBeenLastCalledWith(true);
    setPrefs({normalize: false});
    player.applyEffects();
    expect(effects.setNormalize).toHaveBeenLastCalledWith(false);
  });
});

describe('background timers', () => {
  // The native module stands in for StarCoreTimer: each start resolves only when the test fires it.
  function nativeTimer() {
    const pending = new Map<number, {ms: number; resolve: (fired: boolean) => void}>();
    const module = {
      start: jest.fn((id: number, ms: number) => new Promise<boolean>(resolve => pending.set(id, {ms, resolve}))),
      cancel: jest.fn((id: number) => {
        pending.get(id)?.resolve(false);
        pending.delete(id);
      }),
    };
    const fire = async (ms: number) => {
      for (const [id, entry] of [...pending]) {
        if (entry.ms === ms) {
          pending.delete(id);
          entry.resolve(true);
        }
      }
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    };
    return {module, pending, fire};
  }

  it('pauses on the minutes sleep timer from the native timer, which keeps running with the screen locked', async () => {
    const native = nativeTimer();
    const {player} = setup({...backgroundTimers(native.module)});
    await player.playTracks(makeTracks(3), 0);
    player.setSleep(15);
    expect(native.module.start).toHaveBeenCalledWith(expect.any(Number), 15 * 60_000);
    await native.fire(15 * 60_000);
    expect(player.state.playing).toBe(false);
    expect(player.state.sleepAt).toBeNull();
  });

  it('publishes a resume through the native timer, not a JS one', async () => {
    const native = nativeTimer();
    const {player, api} = setup({...backgroundTimers(native.module)});
    await player.playTracks(makeTracks(3), 0);
    player.toggle();
    api.publishState.mockClear();
    player.toggle();
    expect(player.state.playing).toBe(true);
    const delays = [...native.pending.values()].map(entry => entry.ms);
    await Promise.all(delays.map(ms => native.fire(ms)));
    expect(api.publishState).toHaveBeenCalledWith('mobile-device-1', expect.objectContaining({playing: true}));
  });

  it('never runs a cancelled or replaced timer', async () => {
    const native = nativeTimer();
    const {player} = setup({...backgroundTimers(native.module)});
    await player.playTracks(makeTracks(3), 0);
    player.setSleep(15);
    player.setSleep(30);
    expect(native.module.cancel).toHaveBeenCalledTimes(1);
    await native.fire(15 * 60_000);
    expect(player.state.playing).toBe(true);
    player.setSleep(null);
    await native.fire(30 * 60_000);
    expect(player.state.playing).toBe(true);
  });

  it('leaves setTimeout in place where the native module is absent', () => {
    expect(backgroundTimers(undefined)).toBeNull();
  });
});
