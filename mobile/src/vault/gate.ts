import {CAPABILITY_VERSIONS, PROTECTED_CAPABILITIES, type CapabilityProvider, type Providers} from '../satellites/ui/contract';

/**
 * Protected documents (UI contract 1.2), the app's side: a document that declares
 * `protected: {capability, setup, forgot?}` belongs to a store its own Satellite keeps locked,
 * and this gate decides what of it may show. The same rules as Mission Control's
 * (mission_control/ui/vault.js):
 *
 * - Before any page it asks the provider's status: not set up, the document's setup page;
 *   locked, the app's own unlock card (src/vault/VaultUnlock.tsx), for a full unlock of this
 *   session; open, the page.
 * - The card's "Forgot your PIN?" (when the document names a forgot page) shows that page
 *   instead: nothing of the store, nothing unlocked. Its way back, or its action, asks again.
 * - A 403 from the document's routes asks status again (`check({quiet})`): locked again means the
 *   card, never an error page with the store's content still behind it.
 * - While the document shows, `keep` tells the server it is still in use, so the unlock outlives
 *   the server's idle time - and only then: an app that dies leaves it open that long at most.
 * - It locks when the document closes, when the server or session changes, and when the app
 *   stays in the background (or every screen of the document is covered) for
 *   LEAVE_GRACE_SECONDS - long enough for the system's file picker or a viewer.
 *
 * One gate serves every screen of a document (its entry and the detail pages pushed over it):
 * see attachGate. No React here, so the tests drive it with fake timers.
 * See docs/ui-contract.md ("protected").
 */

/** How often a shown document calls keep; well inside the server's idle time. */
export const KEEP_SECONDS = 30;
/** How long a hidden document keeps the unlock before it locks. */
export const LEAVE_GRACE_SECONDS = 10;

export type GateState = 'checking' | 'setup' | 'locked' | 'forgot' | 'open' | 'failed';

/** The provider of a protected document's store - its own Satellite's, offering every
 * operation the gate calls - or null when this app can't open it. */
export function protectedProvider(document: any, capabilities: Providers | null | undefined, satellite: string): CapabilityProvider | null {
  const capability = document?.protected?.capability;
  const required = typeof capability === 'string' && Object.prototype.hasOwnProperty.call(PROTECTED_CAPABILITIES, capability)
    ? PROTECTED_CAPABILITIES[capability]
    : null;
  if (!required) {
    return null;
  }
  const versions = CAPABILITY_VERSIONS[capability] ?? [];
  const provider = (capabilities?.[capability] ?? []).find(
    entry => entry && entry.satellite === satellite && versions.includes(entry.version),
  );
  const operations = provider?.operations ?? {};
  return provider && required.every(name => typeof operations[name] === 'string') ? provider : null;
}

/** What a status answer means for the document. */
export function gateState(status: any): Exclude<GateState, 'checking'> {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return 'failed';
  }
  if (!status.configured || !status.pin_set || status.pin_unreadable || status.security?.problem) {
    return 'setup';
  }
  return status.unlocked === true ? 'open' : 'locked';
}

/** What the gate calls: the provider's status, keep and lock (src/vault/api.ts). */
export interface GateStore {
  status(): Promise<unknown>;
  keep(): Promise<void>;
  lock(): Promise<void>;
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (id: any) => void;
  setInterval: (fn: () => void, ms: number) => any;
  clearInterval: (id: any) => void;
}

export interface VaultGate {
  state(): GateState;
  /** why it failed, when it did */
  detail(): string | null;
  subscribe(listener: (state: GateState) => void): () => void;
  /** Asks status and shows what it says. `quiet` keeps what shows until the answer (after a
   * 403, or keep's refusal): content fetched while open stays until the server says locked. */
  check(options?: {quiet?: boolean}): Promise<void>;
  /** The unlock card opened the store: shown at once, kept while shown. */
  opened(): void;
  /** "Forgot your PIN?" on the card: the forgot page instead, while locked; check() leads back. */
  forgot(): void;
  setHidden(hidden: boolean): void;
  /** Locks now: the document closed, or stayed hidden past the grace. */
  leave(): void;
  dispose(): void;
}

export function createVaultGate({
  store,
  timers = globalThis as unknown as Timers,
  keepSeconds = KEEP_SECONDS,
  graceSeconds = LEAVE_GRACE_SECONDS,
}: {
  store: GateStore;
  timers?: Timers;
  keepSeconds?: number;
  graceSeconds?: number;
}): VaultGate {
  let current: GateState = 'checking';
  let why: string | null = null;
  let run = 0; // each check or leave starts a new run: an older answer is dropped
  let keeper: any = null;
  let grace: any = null;
  let hidden = false;
  let left = false;
  let disposed = false;
  const listeners = new Set<(state: GateState) => void>();

  const set = (next: GateState, detail: string | null = null) => {
    if (disposed || (next === current && detail === why)) {
      return;
    }
    current = next;
    why = detail;
    listeners.forEach(listener => listener(next));
  };

  const sendLock = () => {
    // best effort: the server's idle time ends it anyway
    store.lock().catch(() => undefined);
  };

  const stopKeeping = () => {
    if (keeper !== null) {
      timers.clearInterval(keeper);
      keeper = null;
    }
  };

  const startKeeping = () => {
    stopKeeping();
    keeper = timers.setInterval(async () => {
      if (hidden || current !== 'open') {
        return;
      }
      try {
        await store.keep();
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 403) {
          check({quiet: true});
        }
        // anything else (StarCore not answering) is for the page's own notice
      }
    }, keepSeconds * 1000);
  };

  async function check({quiet = false}: {quiet?: boolean} = {}): Promise<void> {
    if (disposed) {
      return;
    }
    const mine = ++run;
    left = false;
    if (!quiet) {
      stopKeeping();
      set('checking');
    }
    let status: unknown;
    try {
      status = await store.status();
    } catch (error: any) {
      if (mine === run) {
        stopKeeping();
        set('failed', error?.message || 'StarCore did not answer.');
      }
      return;
    }
    if (mine !== run) {
      return;
    }
    const next = gateState(status);
    if (next === 'open') {
      if (current !== 'open' || keeper === null) {
        set('open');
        startKeeping();
      }
      return;
    }
    stopKeeping();
    set(next, next === 'failed' ? 'StarCore’s answer couldn’t be read.' : null);
  }

  function leave() {
    if (disposed) {
      return;
    }
    run += 1;
    left = true;
    if (grace !== null) {
      timers.clearTimeout(grace);
      grace = null;
    }
    stopKeeping();
    if (current !== 'setup' && current !== 'forgot') {
      sendLock();
    }
    set('locked');
  }

  return {
    state: () => current,
    detail: () => why,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    opened() {
      if (disposed || left) {
        // an unlock that landed after the document locked or closed: locked again at once
        sendLock();
        return;
      }
      run += 1; // a check still on its way is older than this
      set('open');
      startKeeping();
    },
    forgot() {
      if (disposed || current !== 'locked') {
        return;
      }
      run += 1;
      stopKeeping();
      set('forgot');
    },
    setHidden(value) {
      hidden = Boolean(value);
      if (grace !== null) {
        timers.clearTimeout(grace);
        grace = null;
      }
      if (hidden) {
        if (current === 'open' || current === 'locked' || current === 'checking') {
          grace = timers.setTimeout(leave, graceSeconds * 1000);
        }
      } else if (left) {
        check();
      }
    },
    leave,
    dispose() {
      leave();
      disposed = true;
      listeners.clear();
    },
  };
}

/**
 * One gate per document on one server, for one session: its entry screen and every detail page
 * pushed over it share it, so moving between them neither asks again nor locks. Each screen
 * attaches with whether it is shown (focused, app in the foreground); the gate is hidden when
 * none is. When the last screen detaches the gate closes - after this tick, so a screen replaced
 * by another of the same document hands it over - and locks.
 */
const gates = new Map<string, {gate: VaultGate; screens: Map<symbol, boolean>; closing: any}>();

export interface GateAttachment {
  gate: VaultGate;
  setShown(shown: boolean): void;
  detach(): void;
}

export function attachGate(key: string, create: () => VaultGate): GateAttachment {
  let entry = gates.get(key);
  if (!entry) {
    const gate = create();
    entry = {gate, screens: new Map(), closing: null};
    gates.set(key, entry);
    gate.check();
  } else if (entry.closing !== null) {
    clearTimeout(entry.closing);
    entry.closing = null;
  }
  const mine = entry;
  const screen = Symbol(key);
  mine.screens.set(screen, false);
  const update = () => mine.gate.setHidden(![...mine.screens.values()].some(Boolean));
  update();
  let attached = true;
  return {
    gate: mine.gate,
    setShown(shown) {
      if (!attached || mine.screens.get(screen) === shown) {
        return;
      }
      mine.screens.set(screen, shown);
      update();
    },
    detach() {
      if (!attached) {
        return;
      }
      attached = false;
      mine.screens.delete(screen);
      if (mine.screens.size) {
        update();
        return;
      }
      mine.closing = setTimeout(() => {
        if (gates.get(key) === mine && !mine.screens.size) {
          gates.delete(key);
          mine.gate.dispose();
        }
      }, 0);
    },
  };
}
