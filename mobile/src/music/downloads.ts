import {musicUrl, streamPath} from './api';
import type {DownloadNative, NetworkType} from './native';
import {serverFolder} from './native';
import {musicKeys, readJson, writeJson} from './storage';
import type {Quality, Track} from './types';

export interface DownloadEntry {
  track: Track;
  relative: string;
  path: string;
  size: number;
  quality: Quality;
  downloadedAt: number;
  lastPlayedAt: number;
}

export interface DownloadJob {
  id: string;
  track: Track;
  status: 'queued' | 'downloading' | 'failed';
  received: number;
  total: number;
  error?: string;
}

export interface DownloadSettings {
  quality: Quality;
  format: string;
  network: 'wifi' | 'any';
  limitMb: number;
}

type Listener = () => void;

/**
 * Offline copies for one server, in app-private storage beneath music/<server>/. The index
 * (what is downloaded, when it was last played) lives in AsyncStorage under the server's id.
 */
export class DownloadManager {
  entries: Record<string, DownloadEntry> = {};
  jobs: DownloadJob[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private loaded: Promise<void>;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private serverId: string,
    private baseUrl: string,
    private token: () => string | null,
    private native: DownloadNative | null,
    private network: () => Promise<NetworkType>,
    private settings: () => DownloadSettings,
    private now: () => number = () => Date.now(),
  ) {
    this.loaded = this.load();
    this.unsubscribe =
      native?.onProgress(event => {
        const job = this.jobs.find(candidate => candidate.id === event.id);
        if (job) {
          job.received = event.received;
          job.total = event.total;
          this.notify();
        }
      }) ?? null;
  }

  get supported(): boolean {
    return this.native !== null;
  }

  dispose() {
    this.unsubscribe?.();
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(listener => listener());
  }

  private async load() {
    this.entries = (await readJson<Record<string, DownloadEntry>>(musicKeys.downloads(this.serverId))) ?? {};
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  private persist() {
    return writeJson(musicKeys.downloads(this.serverId), this.entries);
  }

  isDownloaded(trackId: string): boolean {
    return trackId in this.entries;
  }

  localUri(trackId: string): string | null {
    const entry = this.entries[trackId];
    return entry ? `file://${entry.path}` : null;
  }

  list(): DownloadEntry[] {
    return Object.values(this.entries).sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  usedBytes(): number {
    return Object.values(this.entries).reduce((total, entry) => total + entry.size, 0);
  }

  search(query: string): Track[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }
    return this.list()
      .map(entry => entry.track)
      .filter(track =>
        [track.title, track.artist, track.album, track.album_artist, track.genre].some(value =>
          (value ?? '').toLowerCase().includes(needle),
        ),
      );
  }

  async markPlayed(trackId: string) {
    const entry = this.entries[trackId];
    if (entry) {
      entry.lastPlayedAt = this.now();
      await this.persist();
    }
  }

  /** Queues tracks; refuses up front on cellular when downloads are Wi-Fi only. */
  async enqueue(tracks: Track[]): Promise<{queued: number; blocked?: string}> {
    await this.loaded;
    if (!this.native) {
      return {queued: 0, blocked: 'Downloads need the Android app.'};
    }
    if (this.settings().network === 'wifi' && (await this.network()) !== 'wifi') {
      return {queued: 0, blocked: 'Downloads are set to Wi-Fi only.'};
    }
    let queued = 0;
    for (const track of tracks) {
      if (track.missing || this.isDownloaded(track.id) || this.jobs.some(job => job.track.id === track.id)) {
        continue;
      }
      this.jobs.push({id: `${track.id}-${this.now()}`, track, status: 'queued', received: 0, total: track.size || 0});
      queued += 1;
    }
    this.notify();
    this.pump();
    return {queued};
  }

  private async pump() {
    if (this.running || !this.native) {
      return;
    }
    this.running = true;
    try {
      let job: DownloadJob | undefined;
      while ((job = this.jobs.find(candidate => candidate.status === 'queued'))) {
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: DownloadJob) {
    const settings = this.settings();
    if (settings.network === 'wifi' && (await this.network()) !== 'wifi') {
      job.status = 'failed';
      job.error = 'Waiting for Wi-Fi';
      this.notify();
      return;
    }
    job.status = 'downloading';
    this.notify();
    const relative = `${serverFolder(this.serverId)}/tracks/${job.track.id}.audio`;
    const token = this.token();
    try {
      const result = await this.native!.download(
        job.id,
        musicUrl(this.baseUrl, streamPath(job.track.id, settings.quality, settings.format)),
        token ? {Authorization: `Bearer ${token}`} : {},
        relative,
      );
      this.entries[job.track.id] = {
        track: job.track,
        relative,
        path: result.path,
        size: result.size,
        quality: settings.quality,
        downloadedAt: this.now(),
        lastPlayedAt: 0,
      };
      this.jobs = this.jobs.filter(candidate => candidate !== job);
      await this.enforceLimit(job.track.id);
      await this.persist();
    } catch (error: any) {
      job.status = 'failed';
      job.error = error?.message ?? 'The download failed';
    }
    this.notify();
  }

  /** Removes least recently played (then oldest) downloads until under the cache limit. */
  async enforceLimit(keep?: string) {
    const limit = this.settings().limitMb * 1024 * 1024;
    const candidates = Object.values(this.entries)
      .filter(entry => entry.track.id !== keep)
      .sort((a, b) => (a.lastPlayedAt || a.downloadedAt) - (b.lastPlayedAt || b.downloadedAt));
    while (this.usedBytes() > limit && candidates.length) {
      await this.remove(candidates.shift()!.track.id, false);
    }
  }

  async remove(trackId: string, persist = true) {
    const entry = this.entries[trackId];
    if (!entry) {
      return;
    }
    await this.native?.remove(entry.relative).catch(() => false);
    delete this.entries[trackId];
    if (persist) {
      await this.persist();
    }
    this.notify();
  }

  async cancel(jobId: string) {
    await this.native?.cancel(jobId).catch(() => false);
    this.jobs = this.jobs.filter(job => job.id !== jobId);
    this.notify();
  }

  retryFailed() {
    this.jobs.forEach(job => {
      if (job.status === 'failed') {
        job.status = 'queued';
        job.error = undefined;
      }
    });
    this.notify();
    this.pump();
  }

  async removeAll() {
    for (const id of Object.keys(this.entries)) {
      await this.remove(id, false);
    }
    await this.persist();
    this.notify();
  }

  /** Local copy of an album cover for the media notification, which can't send auth headers. */
  async artworkFile(albumId: string): Promise<string | null> {
    if (!this.native || !/^[0-9a-f]{8,64}$/.test(albumId)) {
      return null;
    }
    const relative = `${serverFolder(this.serverId)}/artwork/${albumId}.jpg`;
    const existing = await this.native.exists(relative).catch(() => null);
    if (existing) {
      return `file://${existing}`;
    }
    const token = this.token();
    try {
      const result = await this.native.download(
        `art-${albumId}`,
        musicUrl(this.baseUrl, `artwork/${albumId}?size=600`),
        token ? {Authorization: `Bearer ${token}`} : {},
        relative,
      );
      return `file://${result.path}`;
    } catch {
      return null;
    }
  }
}
