// Node's own modules, through Jest's require (this app's TypeScript setup has no Node types)
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};

import {references, runSecure, SECURE_OPERATIONS, secureRunner, type SecurePrompt} from '../src/satellites/ui/secure';

// The secure action (UI contract 1.2), the app's side: which provider and prompt it runs with, the
// references it sends, and the flow - a single-use grant for exactly these items from the app's
// own prompt, never an unlock, and never a PIN through shared code.

const vocabulary = JSON.parse(readFileSync(join(__dirname, '../../contracts/ui/vocabulary.json'), 'utf-8'));
const VAULT = {satellite: 'Vault', version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', move_in: 'move_in'}};
const GALLERY = {satellite: 'Gallery', version: 1, enabled: true, operations: {list: 'media', thumbnail: 'thumbs', resolve: 'media/resolve'}};
const CATALOG = {'media.vault': [VAULT], 'media.gallery': [GALLERY]};
const PROMPT: SecurePrompt = {capability: 'media.vault', satellite: 'Vault', component: () => null};
const MOVE = {secure: {capability: 'media.vault', operation: 'move_in'}, item: '$.id'};

describe('the secure action', () => {
  it('runs exactly the operations the shared vocabulary allows', () => {
    const shared = Object.fromEntries(Object.entries(vocabulary.secure_operations).filter(([name]) => !name.startsWith('_')));
    expect(SECURE_OPERATIONS).toEqual(shared);
  });

  it('runs only for the gallery provider’s own document, with a prompt registered for that provider', () => {
    expect(secureRunner(MOVE, CATALOG, 'Gallery', [PROMPT])).toEqual({provider: VAULT, prompt: PROMPT});
    expect(secureRunner(MOVE, CATALOG, 'Other', [PROMPT])).toBeNull();
    expect(secureRunner(MOVE, CATALOG, 'Gallery', [])).toBeNull(); // no prompt of the app's own
    expect(secureRunner(MOVE, CATALOG, 'Gallery', [{...PROMPT, satellite: 'Elsewhere'}])).toBeNull();
    expect(secureRunner({...MOVE, secure: {capability: 'media.vault', operation: 'move_out'}}, CATALOG, 'Gallery', [PROMPT])).toBeNull();
    expect(secureRunner(MOVE, {...CATALOG, 'media.vault': [{...VAULT, enabled: false}]}, 'Gallery', [PROMPT])).toBeNull();
    expect(secureRunner(MOVE, {'media.gallery': [GALLERY]}, 'Gallery', [PROMPT])).toBeNull();
    expect(secureRunner({route: 'x'}, CATALOG, 'Gallery', [PROMPT])).toBeNull();
  });

  it('names the document’s own Satellite in its references, once per item', () => {
    expect(references('Gallery', ['a', 7, 'a', null, ''])).toEqual([
      {provider: 'Gallery', capability: 'media.gallery', id: 'a'},
      {provider: 'Gallery', capability: 'media.gallery', id: '7'},
    ]);
  });

  function server(status: any = {configured: true, pin_set: true, unlocked: false}, move?: (body: any) => any) {
    const calls: any[] = [];
    return {
      calls,
      read: async (route: string) => {
        calls.push([route]);
        return status;
      },
      post: async (route: string, body: any) => {
        calls.push([route, JSON.parse(JSON.stringify(body))]);
        return move ? move(body) : {moved: body.items.map(({id}: any) => ({id})), failed: []};
      },
    };
  }
  const run = (srv: ReturnType<typeof server>, ids: unknown[], grant: (wanted: any) => Promise<string | null>) =>
    runSecure({action: MOVE, ids, satellite: 'Gallery', provider: VAULT, read: srv.read, post: srv.post, grant});

  it('locked: the prompt is asked for exactly these items, and the move carries only the grant', async () => {
    const srv = server();
    const asked: any[] = [];
    const result = await run(srv, ['a', 'b', 'a'], async wanted => {
      asked.push(wanted);
      return 'g-1';
    });
    expect(result).toMatchObject({outcome: 'done', text: 'Moved 2 items.'});
    expect(asked).toEqual([{operation: 'move_in', items: references('Gallery', ['a', 'b'])}]);
    expect(srv.calls).toEqual([['status'], ['move_in', {items: references('Gallery', ['a', 'b']), grant: 'g-1'}]]);
  });

  it('already unlocked: no prompt and no grant', async () => {
    const srv = server({configured: true, pin_set: true, unlocked: true});
    const result = await run(srv, ['a'], async () => {
      throw new Error('no prompt');
    });
    expect(result.outcome).toBe('done');
    expect(srv.calls[1]).toEqual(['move_in', {items: references('Gallery', ['a'])}]);
  });

  it('cancelled, or not set up: nothing moves', async () => {
    const cancelled = server();
    expect((await run(cancelled, ['a'], async () => null)).outcome).toBe('cancelled');
    expect(cancelled.calls).toEqual([['status']]);
    const unset = server({configured: true, pin_set: false});
    expect((await run(unset, ['a'], async () => 'g')).outcome).toBe('setup');
    expect(unset.calls).toEqual([['status']]);
  });

  it('a partial move is reported as partial, never as done', async () => {
    const srv = server(undefined, () => ({moved: [{id: 'a'}], failed: [{id: 'b', reason: 'it is no longer in the library'}]}));
    expect(await run(srv, ['a', 'b'], async () => 'g')).toMatchObject({
      outcome: 'partial',
      text: 'Moved 1 of 2; 1 item couldn’t be: it is no longer in the library.',
    });
    const none = server(undefined, () => ({moved: [], failed: [{id: 'a', reason: 'the disk is full'}]}));
    expect(await run(none, ['a'], async () => 'g')).toMatchObject({outcome: 'failed', text: 'Nothing was moved: the disk is full.'});
  });
});
