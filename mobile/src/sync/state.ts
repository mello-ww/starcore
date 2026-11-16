import type {SyncState} from './native';

/** The sync screen's state line, and whether it asks the person for something. */
export interface SyncLine {
  text: string;
  tone: 'normal' | 'attention';
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(milliseconds: number, now: number): string {
  const seconds = Math.max(0, (now - milliseconds) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h ago`;
  }
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** What a waiting run waits for: the conditions the person chose, which the system enforces. */
function waitingFor(state: SyncState): string {
  if (state.network === 'none') {
    return 'Waiting for a network';
  }
  if (state.network === 'metered' && !state.mobileData) {
    return 'Waiting for Wi-Fi';
  }
  if (state.charging && !state.plugged) {
    return 'Waiting for the charger';
  }
  if (state.batteryLow) {
    return 'Waiting for the battery to charge';
  }
  return state.phase === 'offline' ? 'Waiting for the server' : 'Starting soon';
}

/** One line for where the backup stands, the most pressing first. */
export function syncLine(state: SyncState, now: number = Date.now()): SyncLine {
  const normal = (text: string): SyncLine => ({text, tone: 'normal'});
  const attention = (text: string): SyncLine => ({text, tone: 'attention'});
  if (!state.configured) {
    return normal('Not set up on this phone');
  }
  if (!state.enabled) {
    return normal('Off');
  }
  if (state.access !== 'full') {
    return attention('Permission needed');
  }
  if (!state.credential || state.phase === 'signed-out') {
    return attention('Sign in again');
  }
  if (state.phase === 'unavailable') {
    return attention("The server doesn't take backups right now");
  }
  if (state.phase === 'server-full') {
    return attention('The server is out of space');
  }
  if (state.running) {
    const total = state.total ?? 0;
    if (state.phase === 'uploading' && total > 0) {
      return normal(`Backing up ${Math.min((state.done ?? 0) + 1, total)} of ${total}`);
    }
    return normal('Looking for new photos and videos');
  }
  if (state.waiting) {
    return normal(waitingFor(state));
  }
  if (state.phase === 'offline') {
    return normal("Couldn't reach the server, it will try again");
  }
  if ((state.pending ?? 0) > 0) {
    return normal(`${state.pending} to back up`);
  }
  if (state.lastRun) {
    return normal(`Up to date, ${timeAgo(state.lastRun, now)}`);
  }
  return normal('Not backed up yet');
}

/** Why an item failed, in words. */
export function failureReason(reason: string): string {
  switch (reason) {
    case 'too-large':
      return 'Larger than the server takes';
    case 'unreadable':
      return "The server couldn't read this file";
    case 'changing':
      return 'The file kept changing while it was sent';
    case 'missing':
      return "This phone couldn't open the file";
    default:
      return 'The server refused it';
  }
}

/** Whether the server is reached over plain HTTP (the screen warns). */
export function isPlainHttp(origin: string | undefined): boolean {
  return !!origin && origin.toLowerCase().startsWith('http://');
}
