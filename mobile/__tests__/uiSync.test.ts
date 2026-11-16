// Node's own modules, through Jest's require (this app's TypeScript setup has no Node types)
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};

import {CLIENT_CAPABILITIES} from '../src/satellites/ui/contract';
import {SYNC_CAPABILITIES, SYNC_VERSIONS, syncTarget} from '../src/satellites/ui/sync';

// The sync action (UI contract 1.2): it opens the app's own sync screen for the document's own
// Satellite, and only where the app has that screen - so far it has none, and hides the control.

const vocabulary = JSON.parse(readFileSync(join(__dirname, '../../contracts/ui/vocabulary.json'), 'utf-8'));

const OWN = {satellite: 'Gallery', version: 1, enabled: true, operations: {status: 'backup/status'}};
const OTHER = {satellite: 'Elsewhere', version: 1, enabled: true, operations: {status: 'backup/status'}};
const ACTION = {sync: {capability: 'media.sync'}};

describe('the sync action', () => {
  it('opens exactly the screens the shared vocabulary lists', () => {
    const shared = Object.fromEntries(Object.entries(vocabulary.sync_capabilities).filter(([name]) => !name.startsWith('_')));
    expect(SYNC_CAPABILITIES).toEqual(shared);
    for (const client of Object.values(SYNC_CAPABILITIES)) {
      expect(vocabulary.client_capabilities.reserved).toContain(client);
    }
  });

  it('is hidden while the app has no sync screen', () => {
    expect(CLIENT_CAPABILITIES.has('device.media-sync')).toBe(false);
    expect(syncTarget(ACTION, {'media.sync': [OWN]}, 'Gallery')).toBeNull();
  });

  describe('with a sync screen', () => {
    beforeEach(() => {
      CLIENT_CAPABILITIES.add('device.media-sync');
      SYNC_VERSIONS['media.sync'] = [1];
    });
    afterEach(() => {
      CLIENT_CAPABILITIES.delete('device.media-sync');
      delete SYNC_VERSIONS['media.sync'];
    });

    it("opens it for the document's own Satellite", () => {
      expect(syncTarget(ACTION, {'media.sync': [OTHER, OWN]}, 'Gallery')).toEqual({provider: OWN, capability: 'media.sync'});
    });

    it("never for another Satellite's provider, a disabled one or a version it doesn't speak", () => {
      expect(syncTarget(ACTION, {'media.sync': [OTHER]}, 'Gallery')).toBeNull();
      expect(syncTarget(ACTION, {'media.sync': [{...OWN, enabled: false}]}, 'Gallery')).toBeNull();
      expect(syncTarget(ACTION, {'media.sync': [{...OWN, version: 2}]}, 'Gallery')).toBeNull();
      expect(syncTarget(ACTION, null, 'Gallery')).toBeNull();
    });

    it('opens nothing for a capability it has no screen for', () => {
      expect(syncTarget({sync: {capability: 'media.gallery'}}, {'media.gallery': [OWN]}, 'Gallery')).toBeNull();
      expect(syncTarget({sync: {capability: 'toString'}}, {}, 'Gallery')).toBeNull();
      expect(syncTarget({sync: 'media.sync'}, {'media.sync': [OWN]}, 'Gallery')).toBeNull();
      expect(syncTarget({navigate: 'home'}, {'media.sync': [OWN]}, 'Gallery')).toBeNull();
    });
  });
});
