import {StarCoreClient, UploadableFile} from '../api/client';
import {ApiError} from '../api/types';
import type {AlbumDetail, AlbumSummary, Photo, TrashListing} from './types';

const BASE = '/api/satellites/photo';

/**
 * The Photo satellite's own REST API, exactly as docs/satellites/photo.md
 * describes it - no logic from satellites/native/photo lives a second time
 * here. This is the one place the mobile Photos screens talk to the server;
 * PhotoLibraryScreen/PhotoFoldersScreen/PhotoSearchScreen/PhotoViewerScreen
 * all go through an instance of this class rather than calling `client`
 * directly, the same convention SatellitesApi/AuthApi already follow.
 */
export class PhotoApi {
  constructor(private client: StarCoreClient) {}

  async list(): Promise<Photo[]> {
    const {status, body} = await this.client.get(`${BASE}/photos`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load your photos.', status);
    }
    return (body.photos ?? []) as Photo[];
  }

  async albums(): Promise<AlbumSummary[]> {
    const {status, body} = await this.client.get(`${BASE}/albums`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load your folders.', status);
    }
    return (body.albums ?? []) as AlbumSummary[];
  }

  async album(albumId: string): Promise<AlbumDetail> {
    const {status, body} = await this.client.get(`${BASE}/albums/${encodeURIComponent(albumId)}`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load this folder.', status);
    }
    return body as AlbumDetail;
  }

  async trashList(): Promise<TrashListing> {
    const {status, body} = await this.client.get(`${BASE}/trash`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load the recycle bin.', status);
    }
    return body as TrashListing;
  }

  /** Moves an active photo to the recycle bin - see "Recycle bin" in
   * docs/satellites/photo.md. Never deletes anything on the phone; only
   * ever the server's own stored copy, and only after this. */
  async trash(photoId: string): Promise<Photo> {
    const {status, body} = await this.client.post(`${BASE}/trash/${encodeURIComponent(photoId)}`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not delete this photo.', status);
    }
    return body as Photo;
  }

  async restore(photoId: string): Promise<Photo> {
    const {status, body} = await this.client.post(`${BASE}/trash/${encodeURIComponent(photoId)}/restore`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not restore this photo.', status);
    }
    return body as Photo;
  }

  async erase(photoId: string): Promise<void> {
    const {status, body} = await this.client.post(`${BASE}/trash/${encodeURIComponent(photoId)}/erase`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not permanently erase this photo.', status);
    }
  }

  /** Uploads one phone photo/video through the authenticated sync route
   * (api.py's `sync_upload`, backed by sync.accept_authenticated_upload) -
   * the same content-addressed ingestion (and therefore the same dedup) as
   * the legacy sync.py upload page, reached through this app's own logged
   * -in session instead of a second server address/token. See "Real
   * automatic phone sync" in docs/satellites/photo.md. Used only by
   * background sync (see photo/backgroundSync.ts); nothing else in the app
   * uploads a file from the phone. */
  async uploadSync(file: UploadableFile): Promise<{status: 'imported' | 'duplicate'; photo: Photo | null}> {
    const {status, body} = await this.client.postFile(
      `${BASE}/sync_upload?filename=${encodeURIComponent(file.name)}`,
      file,
    );
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not upload this file.', status);
    }
    return body as {status: 'imported' | 'duplicate'; photo: Photo | null};
  }
}

/** The URL (and, when signed in, the auth header) to load one photo's
 * thumbnail or original - for `<Image source={{uri, headers}}>`, which is
 * how a native Image loads an authenticated resource (there is no cookie
 * jar to rely on the way a browser has one). `trashed` routes the request
 * through the recycle bin's own preview endpoints (see api.py's
 * `trash_route`), since an ordinary thumbnails/<id> 404s for a photo that's
 * currently in the bin. */
export function photoImageSource(
  baseUrl: string,
  token: string | null,
  photoId: string,
  kind: 'thumbnail' | 'original' = 'thumbnail',
  trashed = false,
) {
  const segment = kind === 'thumbnail' ? 'thumbnails' : 'originals';
  const path = trashed
    ? `${BASE}/trash/${encodeURIComponent(photoId)}/${kind === 'thumbnail' ? 'thumbnail' : 'original'}`
    : `${BASE}/${segment}/${encodeURIComponent(photoId)}`;

  return {
    uri: `${baseUrl}${path}`,
    headers: token ? {Authorization: `Bearer ${token}`} : undefined,
  };
}
