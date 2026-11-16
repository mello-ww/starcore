import AsyncStorage from '@react-native-async-storage/async-storage';
import {purgeRetiredKeys, resetRetiredPurgeForTests} from '../src/storage/retired';

// What an earlier version of the app kept for a removed feature goes at start, and nothing else.

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRetiredPurgeForTests();
});

it('removes the retired keys, for every server, and keeps the rest', async () => {
  await AsyncStorage.multiSet([
    ['starcore_photo_sync_state', '{}'],
    ['starcore_photo_sync_state:server-1', '{"enabled":true}'],
    ['starcore_photo_sync_state:server-2', '{"enabled":false}'],
    ['starcore_photo_sync_statement', 'not one of them'],
    ['starcore_servers', '[]'],
  ]);

  await purgeRetiredKeys();

  expect([...(await AsyncStorage.getAllKeys())].sort()).toEqual(['starcore_photo_sync_statement', 'starcore_servers']);
});

it('runs once per start, and again after a failure', async () => {
  const getAllKeys = jest.spyOn(AsyncStorage, 'getAllKeys');
  getAllKeys.mockRejectedValueOnce(new Error('unavailable'));
  await purgeRetiredKeys();
  await AsyncStorage.setItem('starcore_photo_sync_state:server-1', '{}');

  await purgeRetiredKeys(); // tried again: the first one failed
  expect(await AsyncStorage.getItem('starcore_photo_sync_state:server-1')).toBeNull();

  await AsyncStorage.setItem('starcore_photo_sync_state:server-1', '{}');
  await purgeRetiredKeys(); // done already in this run
  expect(await AsyncStorage.getItem('starcore_photo_sync_state:server-1')).toBe('{}');
  getAllKeys.mockRestore();
});
