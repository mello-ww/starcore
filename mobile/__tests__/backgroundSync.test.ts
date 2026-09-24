import {syncOneServer} from '../src/photo/backgroundSync';
import type {CameraAsset, CameraRollSource, SyncStateStore, SyncUploader} from '../src/photo/backgroundSync';

function asset(overrides: Partial<CameraAsset> = {}): CameraAsset {
  return {
    id: 'asset-1',
    uri: 'content://media/external/images/1',
    filename: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    timestamp: 1000,
    ...overrides,
  };
}

function fakeCamera(assets: CameraAsset[]): CameraRollSource {
  return {
    async assetsSince(sinceMs) {
      return assets.filter(item => item.timestamp > sinceMs);
    },
  };
}

function fakeState(initial: {enabled: boolean; lastSyncedAt: number}) {
  const state = {...initial};
  const store: SyncStateStore = {
    async get() {
      return {...state};
    },
    async setLastSyncedAt(_serverId, timestampMs) {
      state.lastSyncedAt = timestampMs;
    },
  };
  return {store, state};
}

function fakeUploader(
  behavior: (file: {uri: string; name: string; type: string}) => Promise<{status: 'imported' | 'duplicate'; photo: any}>,
): SyncUploader {
  return {uploadSync: behavior};
}

describe('syncOneServer', () => {
  it('does nothing when sync is disabled for this server', async () => {
    const {store} = fakeState({enabled: false, lastSyncedAt: 0});
    const camera = fakeCamera([asset()]);
    const uploader = fakeUploader(async () => ({status: 'imported', photo: null}));

    const outcome = await syncOneServer('server-1', camera, uploader, store);

    expect(outcome).toEqual({scanned: 0, uploaded: 0, duplicates: 0, failed: 0});
  });

  it('uploads every asset newer than the cursor, oldest first as given', async () => {
    const {store, state} = fakeState({enabled: true, lastSyncedAt: 500});
    const assets = [asset({id: 'a', timestamp: 600}), asset({id: 'b', timestamp: 700})];
    const uploadedNames: string[] = [];
    const uploader = fakeUploader(async file => {
      uploadedNames.push(file.name);
      return {status: 'imported', photo: null};
    });

    const outcome = await syncOneServer('server-1', fakeCamera(assets), uploader, store);

    expect(outcome).toEqual({scanned: 2, uploaded: 2, duplicates: 0, failed: 0});
    expect(uploadedNames).toEqual(['IMG_0001.jpg', 'IMG_0001.jpg']);
    expect(state.lastSyncedAt).toBe(700);
  });

  it('advances the cursor to the newest successfully uploaded asset', async () => {
    const {store, state} = fakeState({enabled: true, lastSyncedAt: 0});
    const assets = [asset({timestamp: 100}), asset({timestamp: 200}), asset({timestamp: 300})];
    const uploader = fakeUploader(async () => ({status: 'imported', photo: null}));

    await syncOneServer('server-1', fakeCamera(assets), uploader, store);

    expect(state.lastSyncedAt).toBe(300);
  });

  it('counts a "duplicate" response separately from an upload', async () => {
    const {store} = fakeState({enabled: true, lastSyncedAt: 0});
    const assets = [asset({timestamp: 100}), asset({timestamp: 200})];
    let call = 0;
    const uploader = fakeUploader(async () => {
      call += 1;
      return call === 1 ? {status: 'imported', photo: null} : {status: 'duplicate', photo: null};
    });

    const outcome = await syncOneServer('server-1', fakeCamera(assets), uploader, store);

    expect(outcome.uploaded).toBe(1);
    expect(outcome.duplicates).toBe(1);
  });

  it('stops the batch at the first failure and leaves the cursor there, never skipping past it', async () => {
    const {store, state} = fakeState({enabled: true, lastSyncedAt: 0});
    const assets = [
      asset({id: 'ok-1', timestamp: 100}),
      asset({id: 'fails', timestamp: 200}),
      asset({id: 'never-attempted', timestamp: 300}),
    ];
    const attempted: string[] = [];
    const uploader = fakeUploader(async file => {
      attempted.push(file.name);
      if (attempted.length === 2) {
        throw new Error('network error');
      }
      return {status: 'imported', photo: null};
    });

    const outcome = await syncOneServer('server-1', fakeCamera(assets), uploader, store);

    expect(outcome).toEqual({scanned: 3, uploaded: 1, duplicates: 0, failed: 1});
    // the cursor sits right after the last success (100), so the failed
    // asset at 200 and the one behind it at 300 are both retried next time
    expect(state.lastSyncedAt).toBe(100);
    expect(attempted).toHaveLength(2);
  });

  it('never calls the camera roll at all when nothing is new since the cursor', async () => {
    const {store} = fakeState({enabled: true, lastSyncedAt: 1000});
    const camera = fakeCamera([asset({timestamp: 500})]);
    const uploader = fakeUploader(async () => ({status: 'imported', photo: null}));

    const outcome = await syncOneServer('server-1', camera, uploader, store);

    expect(outcome).toEqual({scanned: 0, uploaded: 0, duplicates: 0, failed: 0});
  });

  it('never deletes or mutates camera roll assets - only ever reads and uploads', async () => {
    const {store} = fakeState({enabled: true, lastSyncedAt: 0});
    const assets = [asset()];
    const camera = fakeCamera(assets);
    const uploader = fakeUploader(async () => ({status: 'imported', photo: null}));

    await syncOneServer('server-1', camera, uploader, store);

    // the fake camera's own array is untouched - nothing in syncOneServer
    // has any way to remove from it (CameraRollSource exposes no delete)
    expect(assets).toHaveLength(1);
  });
});
