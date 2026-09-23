import AsyncStorage from '@react-native-async-storage/async-storage';
import * as store from '../src/storage/preferences';

/**
 * The multi-server storage layer (src/storage/preferences.ts) - add,
 * remove, switch, and the one-time migration from this app's previous
 * single-server storage. Uses the real AsyncStorage mock (see
 * jest.setup.js), the same as the rest of this module would at runtime -
 * there's no native module involved to fake around here.
 */
describe('server storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  describe('addServer / getServers', () => {
    it('starts empty', async () => {
      expect(await store.getServers()).toEqual([]);
    });

    it('adds a server with a generated, stable id', async () => {
      const server = await store.addServer('Home', 'https://192.168.1.20:8090/');

      expect(server.name).toBe('Home');
      expect(server.baseUrl).toBe('https://192.168.1.20:8090'); // trailing slash trimmed
      expect(await store.getServers()).toEqual([server]);
    });

    it('falls back to a default name when none is given', async () => {
      const server = await store.addServer('   ', 'https://a.example');
      expect(server.name).toBe('StarCore');
    });

    it('gives each server a distinct id', async () => {
      const a = await store.addServer('A', 'https://a.example');
      const b = await store.addServer('B', 'https://b.example');
      expect(a.id).not.toBe(b.id);
    });

    it('does not activate a server on its own', async () => {
      await store.addServer('Home', 'https://a.example');
      expect(await store.getActiveServerId()).toBeNull();
    });
  });

  describe('removeServer', () => {
    it('removes only the matching server', async () => {
      const a = await store.addServer('A', 'https://a.example');
      const b = await store.addServer('B', 'https://b.example');

      await store.removeServer(a.id);

      expect(await store.getServers()).toEqual([b]);
    });
  });

  describe('active server', () => {
    it('is null until explicitly set', async () => {
      expect(await store.getActiveServerId()).toBeNull();
    });

    it('is remembered once set', async () => {
      const server = await store.addServer('Home', 'https://a.example');
      await store.setActiveServerId(server.id);

      expect(await store.getActiveServerId()).toBe(server.id);
    });

    it('can be cleared', async () => {
      const server = await store.addServer('Home', 'https://a.example');
      await store.setActiveServerId(server.id);

      await store.setActiveServerId(null);

      expect(await store.getActiveServerId()).toBeNull();
    });
  });

  describe('migrateLegacySingleServer', () => {
    const LEGACY_KEY = 'starcore_server_url';

    it('turns a previously-saved single server URL into a first server and activates it', async () => {
      await AsyncStorage.setItem(LEGACY_KEY, 'https://old.example:8090/');

      await store.migrateLegacySingleServer();

      const servers = await store.getServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].baseUrl).toBe('https://old.example:8090');
      expect(await store.getActiveServerId()).toBe(servers[0].id);
      expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull(); // migrated, not left behind
    });

    it('does nothing when there was never a legacy URL', async () => {
      await store.migrateLegacySingleServer();
      expect(await store.getServers()).toEqual([]);
    });

    it('does nothing once servers already exist, even if the legacy key is still present', async () => {
      await store.addServer('Already set up', 'https://new.example');
      await AsyncStorage.setItem(LEGACY_KEY, 'https://old.example');

      await store.migrateLegacySingleServer();

      const servers = await store.getServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('Already set up');
    });

    it('is safe to call more than once', async () => {
      await AsyncStorage.setItem(LEGACY_KEY, 'https://old.example');

      await store.migrateLegacySingleServer();
      await store.migrateLegacySingleServer();

      expect(await store.getServers()).toHaveLength(1);
    });
  });
});
