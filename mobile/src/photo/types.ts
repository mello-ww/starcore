/** Mirrors what `satellites/native/photo/library.py` and `albums.py` put on
 * the wire - see docs/satellites/photo.md, "API". Nothing here is invented:
 * every field is exactly what the server already sends to Mission Control's
 * own gallery, so this app never becomes a second source of truth for what
 * a photo or album looks like. */
export interface PhotoMetadata {
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  focal_length: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  iso: number | null;
  orientation: number | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_coordinates: string | null;
  megapixels: number | null;
}

export interface Photo {
  id: string;
  filename: string;
  path: string;
  size: number;
  /** null for a video whose display size couldn't be read from its
   * container (see videos.py's probe()) - width/height are never assumed. */
  width: number | null;
  height: number | null;
  format: 'jpeg' | 'png' | 'webp' | 'mp4' | 'mov' | '3gp';
  /** Added alongside video support - library.py backfills "photo" for any
   * record imported before it existed, so this is never missing on the
   * wire even for an old library. */
  media_type: 'photo' | 'video';
  /** Seconds, only meaningful (and only ever non-null) when media_type is
   * 'video' - see videos.py's probe(). */
  duration: number | null;
  imported_at: string;
  captured_at: string | null;
  metadata: PhotoMetadata;
  /** Present (and non-null) only in a GET /trash listing - see
   * PhotoLibrary.trash() in library.py. An active photo never carries this
   * as anything but null/absent, so `!!photo.trashed_at` is enough to tell
   * the two apart wherever both can occur. */
  trashed_at?: string | null;
}

export interface AlbumSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  photo_count: number;
  cover_photo_id: string | null;
}

export interface AlbumDetail extends AlbumSummary {
  photo_ids: string[];
  photos: Photo[];
}

export interface TrashListing {
  photos: Photo[];
  retention_days: number;
}
