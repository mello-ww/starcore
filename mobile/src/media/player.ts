import {authHeaders, type AudioLibraryClient} from './library';
import type {DownloadManager} from './downloads';
import type {AudioEffects, NetworkType} from './native';
import * as Q from './queue';
import type {SavedQueue} from './storage';
import type {MusicPreferences, PlaybackPlan, Quality, QueueState, RepeatMode, Track} from './types';

export interface Source {
  uri: string;
  headers?: Record<string, string>;
  local: boolean;
  quality: Quality;
}

export interface PlayerState {
  queue: Q.Queue;
  track: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  buffering: boolean;
  error: string | null;
  source: Source | null;
  sourceKey: number;
  plan: PlaybackPlan | null;
  volume: number;
  speed: number;
  context: string | null;
  sleepAt: number | null;
  sleepAtEnd: boolean;
  remote: {device: string; name: string; state: any} | null;
}

export interface PlayerDeps {
  /** The audio.library provider's client (see library.ts). */
  api: Pick<AudioLibraryClient, 'path' | 'streamPath' | 'playback' | 'recordPlay' | 'saveQueue' | 'publishState' | 'radio' | 'command'>
    & Partial<Pick<AudioLibraryClient, 'ready'>>;
  /** The server's origin; stream URLs are this plus the provider's path. */
  baseUrl: string;
  token: () => string | null;
  deviceId: () => string | null;
  downloads: DownloadManager | null;
  effects: AudioEffects;
  network: () => Promise<NetworkType>;
  preferences: () => MusicPreferences | null;
  saveLocal: (saved: SavedQueue) => void;
  requestNotifications?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}

const MAX_RETRIES = 3;
const SERVER_SAVE_MS = 10_000;
const LOCAL_SAVE_MS = 2_000;
const RESTART_THRESHOLD = 3;

type Listener = (state: PlayerState) => void;

export class PlayerController {
  state: PlayerState = {
    queue: Q.emptyQueue,
    track: null,
    playing: false,
    position: 0,
    duration: 0,
    buffering: false,
    error: null,
    source: null,
    sourceKey: 0,
    plan: null,
    volume: 1,
    speed: 1,
    context: null,
    sleepAt: null,
    sleepAtEnd: false,
    remote: null,
  };
  seeker: ((seconds: number) => void) | null = null;
  private listeners = new Set<Listener>();
  private listened = 0;
  private lastProgress: number | null = null;
  private retries = 0;
  private pendingSeek: number | null = null;
  private sleepTimer: any = null;
  private retryTimer: any = null;
  private localTimer: any = null;
  private serverTimer: any = null;
  private notifiedPermission = false;
  private gainDb = 0;
  private now: () => number;
  private setTimer: (callback: () => void, ms: number) => any;
  private clearTimer: (handle: any) => void;

  constructor(private deps: PlayerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(changes: Partial<PlayerState>) {
    this.state = {...this.state, ...changes};
    this.listeners.forEach(listener => listener(this.state));
  }

  dispose() {
    this.flushListen();
    [this.sleepTimer, this.retryTimer, this.localTimer, this.serverTimer].forEach(timer => timer && this.clearTimer(timer));
    this.listeners.clear();
  }

  // ---------- loading ----------

  async playTracks(tracks: Track[], start = 0, context: string | null = null, shuffle?: boolean, startAt = 0) {
    this.flushListen();
    this.pendingSeek = startAt > 0 ? startAt : null;
    const queue = Q.load(tracks, start, shuffle ?? this.state.queue.shuffle, this.state.queue.repeat);
    this.set({queue, context, remote: null});
    await this.loadCurrent(true);
  }

  restore(saved: SavedQueue) {
    const queue: Q.Queue = {
      tracks: saved.tracks,
      order: saved.order,
      position: saved.position,
      shuffle: saved.shuffle,
      repeat: saved.repeat,
    };
    if (!Q.current(queue)) {
      return;
    }
    this.pendingSeek = saved.seconds > 0 ? saved.seconds : null;
    this.set({queue, context: saved.context, position: saved.seconds});
    this.loadCurrent(false);
  }

  private async loadCurrent(play: boolean) {
    const track = Q.current(this.state.queue);
    this.retries = 0;
    this.listened = 0;
    this.lastProgress = null;
    if (!track) {
      this.set({track: null, playing: false, source: null, position: 0, duration: 0, plan: null});
      this.persist();
      return;
    }
    if (play) {
      this.ensureNotificationPermission();
    }
    this.set({track, playing: play, error: null, buffering: true, position: this.pendingSeek ?? 0,
      duration: track.duration ?? 0});
    let source: Source;
    try {
      source = await this.resolveSource(track, false);
    } catch (failure: any) {
      if (Q.current(this.state.queue)?.id === track.id) {
        this.set({playing: false, buffering: false, error: failure?.message ?? 'Could not play this track.'});
      }
      return;
    }
    if (Q.current(this.state.queue)?.id !== track.id) {
      return;
    }
    const same = this.state.source?.uri === source.uri;
    this.set({source, sourceKey: same ? this.state.sourceKey + 1 : this.state.sourceKey});
    this.persist();
  }

  private async quality(): Promise<Quality> {
    const preferences = this.deps.preferences();
    if (!preferences) {
      return 'original';
    }
    const network = await this.deps.network().catch(() => 'unknown' as NetworkType);
    return network === 'cellular' ? preferences.cellular_quality : preferences.streaming_quality;
  }

  async resolveSource(track: Track, forceOriginal: boolean): Promise<Source> {
    const local = this.deps.downloads?.localUri(track.id);
    if (local) {
      this.deps.downloads?.markPlayed(track.id);
      this.set({plan: null});
      this.applyGain(this.trackGain(track));
      return {uri: local, local: true, quality: 'original'};
    }
    // a queue restored at launch asks before the catalog has named the provider
    await this.deps.api.ready;
    const quality = forceOriginal ? 'original' : await this.quality();
    const format = this.deps.preferences()?.transcode_format ?? 'opus';
    let path = this.deps.api.streamPath(track.id, quality, format);
    try {
      const info = await this.deps.api.playback(track.id, quality);
      this.set({plan: info.plan});
      this.applyGain(info.gain.db);
      path = info.stream;
    } catch {
      this.set({plan: null});
      this.applyGain(this.trackGain(track));
    }
    if (!path || !this.deps.api.path) {
      throw new Error('There is no audio library to play from.');
    }
    return {uri: `${this.deps.baseUrl}${this.deps.api.path}/${path}`, headers: authHeaders(this.deps.token()), local: false, quality};
  }

  private trackGain(track: Track): number {
    const mode = this.deps.preferences()?.replaygain ?? 'album';
    if (mode === 'off' || !track.replaygain) {
      return 0;
    }
    const first = mode === 'album' ? track.replaygain.album_gain : track.replaygain.track_gain;
    const second = mode === 'album' ? track.replaygain.track_gain : track.replaygain.album_gain;
    return first ?? second ?? 0;
  }

  /** Attenuation through the player volume, boosts through the loudness enhancer. */
  private applyGain(db: number) {
    this.gainDb = Number.isFinite(db) ? Math.max(-24, Math.min(db, 12)) : 0;
    this.deps.effects.setLoudness(this.gainDb > 0 ? this.gainDb * 100 : 0).catch(() => undefined);
    this.set({volume: this.effectiveVolume()});
  }

  effectiveVolume(): number {
    return this.gainDb < 0 ? Math.pow(10, this.gainDb / 20) : 1;
  }

  private ensureNotificationPermission() {
    if (!this.notifiedPermission) {
      this.notifiedPermission = true;
      this.deps.requestNotifications?.();
    }
  }

  // ---------- transport ----------

  play() {
    if (this.state.remote) {
      this.remote('play');
      return;
    }
    if (!this.state.track) {
      return;
    }
    this.ensureNotificationPermission();
    if (this.state.error) {
      this.retry();
      return;
    }
    this.set({playing: true});
    this.persist();
  }

  pause() {
    if (this.state.remote) {
      this.remote('pause');
      return;
    }
    this.set({playing: false});
    this.persist(true);
  }

  toggle() {
    const playing = this.state.remote ? this.state.remote.state?.playing : this.state.playing;
    if (playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  async next(manual = true) {
    if (this.state.remote && manual) {
      this.remote('next');
      return;
    }
    this.flushListen();
    const position = Q.nextPosition(this.state.queue, manual);
    if (position === null) {
      await this.queueEnded();
      return;
    }
    if (position === this.state.queue.position && !manual) {
      this.seek(0);
      this.set({playing: true});
      return;
    }
    this.pendingSeek = null;
    this.set({queue: {...this.state.queue, position}});
    await this.loadCurrent(true);
  }

  async previous() {
    if (this.state.remote) {
      this.remote('previous');
      return;
    }
    if (this.state.position > RESTART_THRESHOLD) {
      this.seek(0);
      return;
    }
    this.flushListen();
    this.pendingSeek = null;
    this.set({queue: {...this.state.queue, position: Q.previousPosition(this.state.queue)}});
    await this.loadCurrent(true);
  }

  private async queueEnded() {
    const preferences = this.deps.preferences();
    const last = this.state.track;
    if (preferences?.queue_end === 'repeat' && this.state.queue.order.length) {
      this.set({queue: {...this.state.queue, position: 0}});
      await this.loadCurrent(true);
      return;
    }
    if (preferences?.queue_end === 'autoplay' && last) {
      try {
        const station = await this.deps.api.radio('track', last.id);
        const fresh = station.tracks.filter(track => !this.state.queue.tracks.some(known => known.id === track.id));
        if (fresh.length) {
          const queue = Q.append(this.state.queue, fresh);
          this.set({queue: {...queue, position: this.state.queue.position + 1}, context: `radio:${last.id}`});
          await this.loadCurrent(true);
          return;
        }
      } catch {
        // no radio offline; just stop
      }
    }
    this.set({playing: false, position: 0});
    this.seek(0);
    this.persist(true);
  }

  seek(seconds: number) {
    if (this.state.remote) {
      this.remote('seek', {position: seconds});
      return;
    }
    const target = Math.max(0, Math.min(seconds, this.state.duration || seconds));
    this.lastProgress = target;
    this.seeker?.(target);
    this.set({position: target});
    this.persist();
  }

  jumpTo(position: number) {
    if (position < 0 || position >= this.state.queue.order.length) {
      return;
    }
    this.flushListen();
    this.pendingSeek = null;
    this.set({queue: {...this.state.queue, position}});
    this.loadCurrent(true);
  }

  setShuffle(on: boolean) {
    if (this.state.remote) {
      this.remote('shuffle', {on});
      return;
    }
    this.set({queue: Q.setShuffle(this.state.queue, on)});
    this.persist();
  }

  cycleRepeat() {
    const mode = Q.cycleRepeat(this.state.queue.repeat);
    if (this.state.remote) {
      this.remote('repeat', {mode});
      return;
    }
    this.setRepeat(mode);
  }

  setRepeat(mode: RepeatMode) {
    this.set({queue: {...this.state.queue, repeat: mode}});
    this.persist();
  }

  playNext(tracks: Track[]) {
    const wasEmpty = !this.state.track;
    this.set({queue: Q.playNext(this.state.queue, tracks.filter(track => !track.missing))});
    if (wasEmpty) {
      this.loadCurrent(false);
    }
    this.persist();
  }

  append(tracks: Track[]) {
    const wasEmpty = !this.state.track;
    this.set({queue: Q.append(this.state.queue, tracks.filter(track => !track.missing))});
    if (wasEmpty) {
      this.loadCurrent(false);
    }
    this.persist();
  }

  removeAt(position: number) {
    const playing = position === this.state.queue.position;
    this.set({queue: Q.removeAt(this.state.queue, position)});
    if (playing) {
      this.loadCurrent(this.state.playing);
    }
    this.persist();
  }

  move(from: number, to: number) {
    this.set({queue: Q.move(this.state.queue, from, to)});
    this.persist();
  }

  clearUpcoming() {
    this.set({queue: Q.clearUpcoming(this.state.queue)});
    this.persist();
  }

  setSpeed(speed: number, semitones?: number) {
    const clamped = Math.max(0.5, Math.min(speed, 2));
    this.set({speed: clamped});
    this.applyPlaybackParameters(semitones);
  }

  applyPlaybackParameters(semitones?: number) {
    const preferences = this.deps.preferences();
    const pitch = semitones ?? preferences?.pitch ?? 0;
    const pitchFollowsSpeed = preferences ? !preferences.preserve_pitch : false;
    const effective = pitchFollowsSpeed ? pitch + 12 * Math.log2(this.state.speed) : pitch;
    if (effective !== 0 || pitchFollowsSpeed) {
      this.deps.effects.setPlaybackParameters(this.state.speed, effective).catch(() => undefined);
    }
  }

  setSleep(minutes: number | 'end' | null) {
    if (this.sleepTimer) {
      this.clearTimer(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (minutes === 'end') {
      this.set({sleepAt: null, sleepAtEnd: true});
      return;
    }
    if (!minutes) {
      this.set({sleepAt: null, sleepAtEnd: false});
      return;
    }
    const ms = minutes * 60_000;
    this.sleepTimer = this.setTimer(() => {
      this.sleepTimer = null;
      this.set({sleepAt: null});
      this.pause();
    }, ms);
    this.set({sleepAt: this.now() + ms, sleepAtEnd: false});
  }

  retry() {
    if (!this.state.track) {
      return;
    }
    this.retries = 0;
    this.set({error: null, playing: true, buffering: true, sourceKey: this.state.sourceKey + 1});
  }

  // ---------- events from the native player ----------

  onLoad(duration: number) {
    this.retries = 0;
    this.set({duration: duration || this.state.track?.duration || 0, buffering: false, error: null});
    if (this.pendingSeek !== null) {
      this.seeker?.(this.pendingSeek);
      this.lastProgress = this.pendingSeek;
      this.pendingSeek = null;
    }
    this.applyEffects();
  }

  applyEffects() {
    const preferences = this.deps.preferences();
    if (!preferences) {
      return;
    }
    const eq = preferences.equalizer;
    this.deps.effects.setEqualizer(eq.enabled, eq.bands, eq.preamp).catch(() => undefined);
    this.deps.effects.setBassBoost(preferences.bass_boost).catch(() => undefined);
    this.applyPlaybackParameters();
  }

  onProgress(seconds: number) {
    if (this.state.playing && this.lastProgress !== null) {
      const delta = seconds - this.lastProgress;
      if (delta > 0 && delta < 5) {
        this.listened += delta;
      }
    }
    this.lastProgress = seconds;
    this.set({position: seconds, buffering: false});
    this.persist();
  }

  onBuffer(buffering: boolean) {
    this.set({buffering});
  }

  async onEnd() {
    this.flushListen();
    if (this.state.sleepAtEnd) {
      this.set({sleepAtEnd: false});
      const position = Q.nextPosition(this.state.queue, true);
      if (position !== null) {
        this.set({queue: {...this.state.queue, position}});
        await this.loadCurrent(false);
      }
      this.set({playing: false});
      this.persist(true);
      return;
    }
    await this.next(false);
  }

  onError(message?: string) {
    const track = this.state.track;
    if (!track) {
      return;
    }
    if (this.retries >= MAX_RETRIES) {
      this.set({error: message || 'This track could not be played.', playing: false, buffering: false});
      return;
    }
    this.retries += 1;
    const delay = 1000 * 2 ** (this.retries - 1);
    this.set({buffering: true});
    this.pendingSeek = this.state.position || null;
    this.retryTimer = this.setTimer(async () => {
      this.retryTimer = null;
      const fallback = this.state.source?.quality !== 'original' || this.retries === MAX_RETRIES;
      const source = await this.resolveSource(track, fallback);
      if (this.state.track?.id === track.id) {
        this.set({source, sourceKey: this.state.sourceKey + 1});
      }
    }, delay);
  }

  /** Another app took audio focus (a call, a navigation prompt) or headphones came out. */
  onInterrupted() {
    if (this.state.playing) {
      this.set({playing: false});
      this.persist(true);
    }
  }

  // ---------- history and persistence ----------

  private flushListen() {
    const track = this.state.track;
    const seconds = Math.round(this.listened);
    this.listened = 0;
    if (!track || seconds <= 0) {
      return;
    }
    this.deps.api
      .recordPlay(track.id, seconds, this.deps.deviceId() ?? '', this.state.context)
      .catch(() => undefined);
  }

  queueState(): QueueState {
    const ids = Q.toIds(this.state.queue);
    return {
      ...ids,
      position: this.state.position,
      duration: this.state.duration,
      playing: this.state.playing,
      volume: 1,
      speed: this.state.speed,
      context: this.state.context,
    };
  }

  saved(): SavedQueue {
    return {
      tracks: this.state.queue.tracks,
      order: this.state.queue.order,
      position: this.state.queue.position,
      shuffle: this.state.queue.shuffle,
      repeat: this.state.queue.repeat,
      seconds: this.state.position,
      context: this.state.context,
    };
  }

  persist(immediate = false) {
    if (immediate) {
      this.saveLocalNow();
      this.saveServerNow();
      return;
    }
    if (!this.localTimer) {
      this.localTimer = this.setTimer(() => this.saveLocalNow(), LOCAL_SAVE_MS);
    }
    if (!this.serverTimer) {
      this.serverTimer = this.setTimer(() => this.saveServerNow(), SERVER_SAVE_MS);
    }
  }

  private saveLocalNow() {
    if (this.localTimer) {
      this.clearTimer(this.localTimer);
      this.localTimer = null;
    }
    this.deps.saveLocal(this.saved());
  }

  private saveServerNow() {
    if (this.serverTimer) {
      this.clearTimer(this.serverTimer);
      this.serverTimer = null;
    }
    const device = this.deps.deviceId();
    if (!device || !this.state.queue.tracks.length) {
      return;
    }
    const state = this.queueState();
    this.deps.api.saveQueue(device, state, 'StarCore Mobile').catch(() => undefined);
    this.deps.api.publishState(device, state).catch(() => undefined);
  }

  // ---------- StarCore Connect ----------

  private remote(command: string, args: Record<string, unknown> = {}) {
    const device = this.deps.deviceId();
    const remote = this.state.remote;
    if (!device || !remote) {
      return;
    }
    this.deps.api.command(device, remote.device, command, args).catch(() => {
      this.set({remote: null});
    });
  }

  setRemote(remote: PlayerState['remote']) {
    this.set({remote});
  }

  updateRemoteState(device: string, state: any) {
    if (this.state.remote?.device === device) {
      this.set({remote: {...this.state.remote, state}});
    }
  }

  /** Applies a command another device sent to this one. Resolver loads tracks by id. */
  async handleCommand(command: string, args: any, resolve: (ids: string[]) => Promise<Track[]>) {
    switch (command) {
      case 'play':
        this.set({remote: null});
        this.play();
        break;
      case 'pause':
        this.pauseLocal();
        if (args?.transferred) {
          this.persist(true);
        }
        break;
      case 'stop':
        this.pauseLocal();
        this.seek(0);
        break;
      case 'toggle':
        if (this.state.playing) {
          this.pauseLocal();
        } else {
          this.play();
        }
        break;
      case 'next':
        await this.next(true);
        break;
      case 'previous':
        await this.previous();
        break;
      case 'seek':
        this.seek(Number(args?.position) || 0);
        break;
      case 'shuffle':
        this.setShuffle(Boolean(args?.on));
        break;
      case 'repeat':
        this.setRepeat(args?.mode);
        break;
      case 'volume':
        break;
      case 'add_queue':
        this.append(await resolve(args.tracks ?? []));
        break;
      case 'play_next':
        this.playNext(await resolve(args.tracks ?? []));
        break;
      case 'set_queue': {
        const tracks = await resolve(args.tracks ?? []);
        await this.playTracks(tracks, args.index ?? 0, args.context ?? null, false, args.position || 0);
        break;
      }
      case 'transfer_in':
        await this.transferIn(args.state, resolve);
        break;
    }
  }

  private pauseLocal() {
    this.set({playing: false});
    this.persist();
  }

  async transferIn(state: QueueState, resolve: (ids: string[]) => Promise<Track[]>) {
    if (!state?.queue?.length) {
      return;
    }
    this.flushListen();
    const tracks = await resolve(state.queue);
    const queue = Q.fromIds(tracks, state.queue, state.index, state.order, state.shuffle, state.repeat);
    this.pendingSeek = state.position || null;
    this.set({queue, context: state.context, remote: null, speed: state.speed || 1});
    await this.loadCurrent(state.playing !== false);
  }
}
