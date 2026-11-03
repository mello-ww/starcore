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
  /** The physical album (a source_paths mapping's server_path) this photo
   * landed in when it was synced from a phone - see library.py's add_file()
   * docstring. Null for anything imported from a desktop directory, or for
   * the standalone local-network listener's own uploads - neither of those
   * ever resolves a physical album at all, which is a deliberate design
   * choice, not a gap (see docs/satellites/photo.md, "Albums"). */
  physical_path: string | null;
}

/** A physical album's id always carries this prefix - see albums.py's own
 * PHYSICAL_ID_PREFIX, which this mirrors exactly so a client never has to
 * ask the server which store an id came from. */
export const PHYSICAL_ALBUM_PREFIX = 'physical:';
/** Favorites' own fixed id - see albums.py's FAVORITES_ID. Always present,
 * even with zero photos, and can't be renamed or deleted. */
export const FAVORITES_ALBUM_ID = 'favorites';

export type AlbumKind = 'physical' | 'virtual' | 'favorites';

export interface AlbumSummary {
  id: string;
  name: string;
  kind: AlbumKind;
  /** Only present on a physical album - the source_paths mapping's own
   * server-side path (see albums.py's physical_albums()). Absent for
   * virtual/Favorites albums, which have no filesystem path at all. */
  server_path?: string | null;
  created_at?: string;
  updated_at?: string;
  photo_count: number;
  cover_photo_id: string | null;
}

export interface AlbumDetail extends AlbumSummary {
  /** Absent for a physical album - its membership is computed from every
   * photo's own physical_path, never stored as an id list (see albums.py's
   * physical_albums()/physical_album_detail()). */
  photo_ids?: string[];
  photos: Photo[];
}

export interface ConfigurationSetting {
  key: string;
  value: unknown;
  label?: string;
  description?: string;
  /** Shown only in Developer Mode - a display hint, never a permission. */
  developer?: boolean;
}

export interface ConfigurationResponse {
  settings: ConfigurationSetting[];
}

/** One phone-folder -> server-path mapping, exactly as configuration.py's
 * `source_paths` setting stores it - see _validate_source_paths(). */
export interface SourcePathMapping {
  id?: string;
  phone_path: string;
  server_path: string;
  name?: string;
}

export interface TrashListing {
  photos: Photo[];
  retention_days: number;
}
