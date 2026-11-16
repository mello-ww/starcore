// Node's own modules, through Jest's require (this app's TypeScript setup has no Node types)
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};

import {
  attachGate,
  createVaultGate,
  gateState,
  KEEP_SECONDS,
  LEAVE_GRACE_SECONDS,
  protectedProvider,
} from '../src/vault/gate';
import {PROTECTED_CAPABILITIES} from '../src/satellites/ui/contract';

// A protected document's gate (UI contract 1.2), the app's side - the same rules as Mission
// Control's (mission_control/tests/vault.test.mjs): status first, keep only while shown, lock on
// leaving, and a 403 asks again instead of showing an error with the store behind it.

const vocabulary = JSON.parse(readFileSync(join(__dirname, '../../contracts/ui/vocabulary.json'), 'utf-8'));
const OPEN = {configured: true, pin_set: true, unlocked: true, expires_at: 'later'};
const LOCKED = {configured: true, pin_set: true, unlocked: false, expires_at: null};
const VAULT = {satellite: 'Vault', version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', keep: 'keep'}};

interface FakeStore {
  answer: unknown;
  status: jest.Mock<Promise<unknown>, []>;
  keep: jest.Mock<Promise<void>, []>;
  lock: jest.Mock<Promise<void>, []>;
}

function fakeStore(answer: unknown = OPEN): FakeStore {
  const store: FakeStore = {
    answer,
    status: jest.fn(async (): Promise<unknown> => {
      if (store.answer instanceof Error) {
        throw store.answer;
      }
      return store.answer;
    }),
    keep: jest.fn(async () => undefined),
    lock: jest.fn(async () => undefined),
  };
  return store;
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe('a protected document’s gate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('gates documents by exactly the stores the shared vocabulary lists', () => {
    const shared = Object.fromEntries(Object.entries(vocabulary.protected_capabilities).filter(([name]) => !name.startsWith('_')));
    expect(PROTECTED_CAPABILITIES).toEqual(shared);
  });

  it('takes the store of the document’s own Satellite, offering every operation the gate calls', () => {
    const document = {protected: {capability: 'media.vault', setup: 'setup'}};
    expect(protectedProvider(document, {'media.vault': [VAULT]}, 'Vault')).toEqual(VAULT);
    expect(protectedProvider(document, {'media.vault': [VAULT]}, 'Other')).toBeNull();
    const noKeep = {...VAULT, operations: {status: 'status', unlock: 'unlock', lock: 'lock'}};
    expect(protectedProvider(document, {'media.vault': [noKeep]}, 'Vault')).toBeNull();
    expect(protectedProvider(document, {'media.vault': [{...VAULT, version: 9}]}, 'Vault')).toBeNull();
    expect(protectedProvider({protected: {capability: 'media.other'}}, {'media.other': [VAULT]}, 'Vault')).toBeNull();
    expect(protectedProvider(document, null, 'Vault')).toBeNull();
  });

  it('reads a status answer', () => {
    expect(gateState(OPEN)).toBe('open');
    expect(gateState(LOCKED)).toBe('locked');
    expect(gateState({...LOCKED, configured: false})).toBe('setup');
    expect(gateState({...LOCKED, pin_set: false})).toBe('setup');
    expect(gateState({...LOCKED, pin_unreadable: true})).toBe('setup');
    expect(gateState({...OPEN, security: {problem: 'pin_tampered'}})).toBe('setup');
    expect(gateState({...OPEN, unlocked: 'yes'})).toBe('locked'); // only true opens it
    expect(gateState(null)).toBe('failed');
    expect(gateState([])).toBe('failed');
  });

  it('unlocked already: it opens, and keeps the unlock alive only while shown', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    expect(gate.state()).toBe('open');
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    await flush();
    expect(store.keep).toHaveBeenCalledTimes(1);
    gate.setHidden(true);
    jest.advanceTimersByTime((LEAVE_GRACE_SECONDS - 1) * 1000);
    expect(store.lock).not.toHaveBeenCalled(); // the system's picker or a viewer has its grace
    gate.setHidden(false);
    jest.advanceTimersByTime(LEAVE_GRACE_SECONDS * 1000);
    expect(store.lock).not.toHaveBeenCalled();
    gate.dispose();
  });

  it('locked: the card, then open once it unlocked, and kept from then on', async () => {
    const store = fakeStore(LOCKED);
    const gate = createVaultGate({store});
    const seen: string[] = [];
    gate.subscribe(state => seen.push(state));
    await gate.check();
    expect(gate.state()).toBe('locked');
    gate.opened();
    expect(gate.state()).toBe('open');
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    await flush();
    expect(store.keep).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['locked', 'open']); // it starts as 'checking'
    gate.dispose();
  });

  it('not set up: the setup page, and nothing to lock', async () => {
    const store = fakeStore({...LOCKED, pin_set: false});
    const gate = createVaultGate({store});
    await gate.check();
    expect(gate.state()).toBe('setup');
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    expect(store.keep).not.toHaveBeenCalled();
    gate.dispose();
    expect(store.lock).not.toHaveBeenCalled();
  });

  it('forgot: the forgot page while locked, nothing to lock, and checking leads back', async () => {
    const store = fakeStore(LOCKED);
    const gate = createVaultGate({store});
    await gate.check();
    gate.forgot();
    expect(gate.state()).toBe('forgot');
    await gate.check();
    expect(gate.state()).toBe('locked');
    gate.forgot();
    gate.dispose();
    expect(store.lock).not.toHaveBeenCalled(); // nothing was unlocked
  });

  it('forgot is only for a locked document', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    gate.forgot();
    expect(gate.state()).toBe('open');
    gate.dispose();
  });

  it('a refused keep asks again: locked again means the card, not an error', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    store.keep.mockRejectedValueOnce(Object.assign(new Error('locked'), {status: 403}));
    store.answer = LOCKED;
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    await flush();
    expect(gate.state()).toBe('locked');
    gate.dispose();
  });

  it('a quiet check keeps what shows until the server answers', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    const seen: string[] = [];
    gate.subscribe(state => seen.push(state));
    store.answer = LOCKED;
    const asking = gate.check({quiet: true});
    expect(gate.state()).toBe('open');
    await asking;
    expect(seen).toEqual(['locked']); // never 'checking' in between
    gate.dispose();
  });

  it('a refused keep that is not the store’s (StarCore not answering) changes nothing', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    store.keep.mockRejectedValueOnce(Object.assign(new Error('offline'), {status: 0}));
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    await flush();
    expect(store.status).toHaveBeenCalledTimes(1);
    expect(gate.state()).toBe('open');
    gate.dispose();
  });

  it('hidden past the grace, it locks; shown again, it asks', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    await gate.check();
    gate.setHidden(true);
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    await flush();
    expect(store.keep).not.toHaveBeenCalled(); // hidden: no keep, the server's idle time runs
    expect(store.lock).toHaveBeenCalledTimes(1);
    expect(gate.state()).toBe('locked');
    store.answer = LOCKED;
    gate.setHidden(false);
    await flush();
    expect(store.status).toHaveBeenCalledTimes(2);
    expect(gate.state()).toBe('locked');
    gate.dispose();
  });

  it('an answer that arrives after leaving is dropped, and an unlock after it locks again', async () => {
    const store = fakeStore(OPEN);
    let answer!: (value: unknown) => void;
    store.status.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const gate = createVaultGate({store});
    const asking = gate.check();
    gate.leave();
    answer(OPEN);
    await asking;
    expect(gate.state()).toBe('locked');
    gate.opened();
    expect(gate.state()).toBe('locked');
    expect(store.lock).toHaveBeenCalledTimes(2);
    gate.dispose();
  });

  it('closing the document locks it, and nothing changes after', async () => {
    const store = fakeStore(OPEN);
    const gate = createVaultGate({store});
    const seen: string[] = [];
    await gate.check();
    gate.subscribe(state => seen.push(state));
    gate.dispose();
    expect(store.lock).toHaveBeenCalledTimes(1);
    await gate.check();
    jest.advanceTimersByTime(KEEP_SECONDS * 1000);
    expect(store.keep).not.toHaveBeenCalled();
    expect(seen).toEqual(['locked']);
  });

  it('StarCore not answering is a failure to show, with nothing behind it', async () => {
    const store = fakeStore(new Error('StarCore did not answer.'));
    const gate = createVaultGate({store});
    await gate.check();
    expect(gate.state()).toBe('failed');
    expect(gate.detail()).toBe('StarCore did not answer.');
    store.answer = {unreadable: true};
    await gate.check();
    expect(gate.state()).toBe('setup');
    gate.dispose();
  });
});

describe('one gate per document, shared by its screens', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('asks once for every screen, and locks when the last one closes', async () => {
    const store = fakeStore(OPEN);
    const create = jest.fn(() => createVaultGate({store}));
    const entry = attachGate('srv|session|Vault', create);
    entry.setShown(true);
    await flush();
    const detail = attachGate('srv|session|Vault', create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(detail.gate).toBe(entry.gate);
    detail.setShown(true);
    entry.setShown(false); // covered by the detail page: still shown
    jest.advanceTimersByTime(LEAVE_GRACE_SECONDS * 1000);
    expect(store.lock).not.toHaveBeenCalled();
    detail.detach();
    entry.detach();
    expect(store.lock).not.toHaveBeenCalled(); // after this tick
    jest.advanceTimersByTime(0);
    expect(store.lock).toHaveBeenCalledTimes(1);
    expect(store.status).toHaveBeenCalledTimes(1);
  });

  it('a screen replaced by another of the same document hands the gate over', async () => {
    const store = fakeStore(OPEN);
    const create = jest.fn(() => createVaultGate({store}));
    const first = attachGate('srv|session|Hand', create);
    first.setShown(true);
    await flush();
    first.detach();
    const second = attachGate('srv|session|Hand', create);
    second.setShown(true);
    jest.advanceTimersByTime(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.lock).not.toHaveBeenCalled();
    second.detach();
    jest.advanceTimersByTime(0);
    expect(store.lock).toHaveBeenCalledTimes(1);
  });

  it('another session or server gets a gate of its own', () => {
    const store = fakeStore(OPEN);
    const create = jest.fn(() => createVaultGate({store}));
    const one = attachGate('srv|one|Own', create);
    const two = attachGate('srv|two|Own', create);
    expect(create).toHaveBeenCalledTimes(2);
    expect(one.gate).not.toBe(two.gate);
    one.detach();
    two.detach();
  });

  it('every screen covered past the grace locks it', async () => {
    const store = fakeStore(OPEN);
    const entry = attachGate('srv|session|Cover', () => createVaultGate({store}));
    entry.setShown(true);
    await flush();
    entry.setShown(false);
    jest.advanceTimersByTime(LEAVE_GRACE_SECONDS * 1000);
    expect(store.lock).toHaveBeenCalledTimes(1);
    expect(entry.gate.state()).toBe('locked');
    entry.detach();
  });
});
