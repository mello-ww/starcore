import type {AudioLibraryClient} from './library';
import type {ConnectEvent} from './types';

export interface ConnectHandlers {
  onCommand(command: string, args: any, event: ConnectEvent): void;
  onRemoteState(device: string, state: any): void;
  onDevicesChanged(): void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * StarCore Connect for this phone: registers it, then long-polls for commands while the app
 * is in the foreground. Android suspends JS networking for a backgrounded app, so remote
 * control of a phone in the background is not offered; it reconnects on returning.
 */
export class ConnectClient {
  private cursor = 0;
  private running = false;
  private generation = 0;
  private failures = 0;
  registered = false;

  constructor(
    private api: Pick<AudioLibraryClient, 'registerDevice' | 'events'>,
    readonly deviceId: string,
    private name: string,
    private handlers: ConnectHandlers,
    private sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  async register(): Promise<boolean> {
    try {
      const result = await this.api.registerDevice(this.deviceId, this.name);
      if (!this.registered) {
        this.cursor = result.cursor ?? 0;
      }
      this.registered = true;
      return true;
    } catch {
      return false;
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    this.loop(generation);
  }

  stop() {
    this.running = false;
    this.generation++;
  }

  get active(): boolean {
    return this.running;
  }

  private async loop(generation: number) {
    while (this.running && generation === this.generation) {
      if (!this.registered && !(await this.register())) {
        await this.backoff();
        continue;
      }
      try {
        const result = await this.api.events(this.deviceId, this.cursor, 25);
        if (generation !== this.generation) {
          return;
        }
        this.failures = 0;
        this.cursor = Math.max(this.cursor, result.cursor ?? this.cursor);
        result.events.forEach(event => this.dispatch(event));
      } catch (error: any) {
        if (error?.status === 400) {
          this.registered = false;
        }
        await this.backoff();
      }
    }
  }

  private async backoff() {
    this.failures += 1;
    await this.sleep(Math.min(1000 * 2 ** Math.min(this.failures, 5), MAX_BACKOFF_MS));
  }

  dispatch(event: ConnectEvent) {
    if (event.type === 'command' && event.target === this.deviceId && event.command) {
      this.handlers.onCommand(event.command, event.arguments ?? {}, event);
    } else if (event.type === 'state' && event.device && event.device !== this.deviceId) {
      this.handlers.onRemoteState(event.device, event.state);
    } else if (event.type === 'devices') {
      this.handlers.onDevicesChanged();
    }
  }
}
