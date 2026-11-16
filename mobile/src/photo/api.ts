import {StarCoreClient} from '../api/client';
import {ApiError} from '../api/types';
import {FAVORITES_ALBUM_ID} from './types';
import type {AlbumDetail, AlbumSummary, ConfigurationResponse, Photo, TrashListing} from './types';

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

  /** Creates a new custom (virtual) album - never valid for a physical
   * album, which api.py rejects for exactly this reason (see
   * albums.py/api.py's PHYSICAL_ID_PREFIX handling). */
  async createAlbum(name: string): Promise<AlbumSummary> {
    const {status, body} = await this.client.post(`${BASE}/albums`, {name});
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not create this album.', status);
    }
    return body as AlbumSummary;
  }

  async renameAlbum(albumId: string, name: string): Promise<AlbumSummary> {
    const {status, body} = await this.client.post(`${BASE}/albums/${encodeURIComponent(albumId)}`, {name});
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not rename this album.', status);
    }
    return body as AlbumSummary;
  }

  async deleteAlbum(albumId: string): Promise<void> {
    const {status, body} = await this.client.post(`${BASE}/albums/${encodeURIComponent(albumId)}/delete`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not delete this album.', status);
    }
  }

  async addPhotoToAlbum(albumId: string, photoId: string): Promise<AlbumSummary> {
    const {status, body} = await this.client.post(`${BASE}/albums/${encodeURIComponent(albumId)}/photos`, {
      photo_id: photoId,
    });
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not add this photo to the album.', status);
    }
    return body as AlbumSummary;
  }

  async removePhotoFromAlbum(albumId: string, photoId: string): Promise<AlbumSummary> {
    const {status, body} = await this.client.post(`${BASE}/albums/${encodeURIComponent(albumId)}/photos/remove`, {
      photo_id: photoId,
    });
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not remove this photo from the album.', status);
    }
    return body as AlbumSummary;
  }

  /** Favorites is just a regular album under a fixed id (see albums.py's
   * FAVORITES_ID) - these two are thin, self-documenting wrappers around
   * the same add/removePhotoFromAlbum calls above, never a second favorite-
   * specific backend mechanism. */
  async favorite(photoId: string): Promise<AlbumSummary> {
    return this.addPhotoToAlbum(FAVORITES_ALBUM_ID, photoId);
  }

  async unfavorite(photoId: string): Promise<AlbumSummary> {
    return this.removePhotoFromAlbum(FAVORITES_ALBUM_ID, photoId);
  }

  /** The satellite's own settings - same generic /configuration route the
   * web panel's Configuration tab uses (see configuration.py), so mobile
   * never becomes a second settings mechanism. */
  async configuration(): Promise<ConfigurationResponse> {
    const {status, body} = await this.client.get(`${BASE}/configuration`);
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not load configuration.', status);
    }
    return body as ConfigurationResponse;
  }

  async updateConfiguration(key: string, value: unknown): Promise<ConfigurationResponse & {note?: string}> {
    const {status, body} = await this.client.post(`${BASE}/configuration`, {key, value});
    if (status !== 200) {
      throw new ApiError(body?.error || 'Could not save this setting.', status);
    }
    return body as ConfigurationResponse & {note?: string};
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
