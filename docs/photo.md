# Photo

The Photo Satellite is StarCore's local photo library.

It manages its own storage, keeps its own metadata index and serves its own Mission Control
page. The Core knows nothing about photos: everything below is contributed through the
Satellite extension points described in the Satellites documentation.

## Storage

Photos live under the Satellite's storage directory, which defaults to `data/` inside the
Satellite itself:

```
satellites/native/photo/
    data/
        photos/<xx>/<id>.<ext>       imported originals, never modified
        thumbnails/<xx>/<id>.jpg     derived, safe to delete at any time
        library.json                 the metadata index
        albums.json                  custom albums (see "Albums" below)
```

A photo's identifier is the first 16 characters of the SHA-256 of its content, and the
stored file is named after it. That makes storage content-addressed: the same image is
never stored twice, filenames from the source can never collide, and a stored file can be
cached by the browser indefinitely. The two-character subdirectory keeps the number of
entries per directory manageable as the library grows.

Originals and derived files are kept apart, so thumbnails can be deleted and regenerated
without ever putting an original at risk.

## Configuration

`satellites/native/photo/config.toml`:

```toml
enabled = true
storage = "data"          # relative paths are resolved inside the satellite
thumbnail_size = 480      # longest edge, in pixels
photo_directory = ""      # default directory 'scan'/'import' use when none is given
```

`storage` may be an absolute path, which is how the library is moved to another disk.

`photo_directory` is the directory `scan` and `import` fall back to when a request doesn't
name a `source` explicitly - see "Import" and "Configuring the default photo directory"
below. Left empty (the default), a `source` must always be given explicitly.

## Supported formats

JPEG, PNG and WEBP. Format, width and height are read from the file header by the
Satellite's own `images.py`, using only the standard library.

## Import

Import copies photos into the library. It never moves, changes or deletes anything in the
source directory, and running it twice over the same folder does nothing the second time.

Importing a directory:

1. walks it recursively and picks out files with a supported extension
2. hashes each one and skips it when that exact image is already stored
3. reads its dimensions, refusing files whose headers cannot be understood
4. copies it aside and moves it into place, so an interrupted import leaves nothing half written
5. records it in the index

The result reports how many files were found, how many were imported, how many were
duplicates, and which files failed and why. A file that cannot be read or decoded is
reported and skipped; it never stops the rest of the import.

`scan` performs the same walk without writing anything, which is what the Mission Control
import panel uses to preview a folder.

A request that doesn't name a `source` falls back to the configured `photo_directory` (see
"Configuration" above); if neither is available, the request is rejected with a clear error
rather than doing nothing silently. An explicit `source` always takes priority over the
configured default when both are present.

## Metadata

For every photo the index records the identifier, the original filename, the stored path,
the file size, width, height, format and the import timestamp. `captured_at` is filled from
the EXIF `DateTimeOriginal` field (falling back to `DateTime`) when the file carries one;
photos without EXIF simply have no capture date. Nothing is guessed or invented.

A JPEG's EXIF segment, when present, also fills a nested `metadata` object on the record:

```
camera_make, camera_model, lens_model
focal_length, aperture, shutter_speed, iso
orientation
gps_latitude, gps_longitude, gps_coordinates   (a human-readable "37.77414° N, 122.41858° W")
megapixels                                     (derived from width x height, not EXIF)
```

Every field defaults to `null` - a photo with no EXIF segment, a format this reads no EXIF
from (PNG, WEBP), or EXIF that is missing, malformed or truncated simply carries less detail
in `metadata` rather than failing the import. This is read straight from the file's own
bytes by the Satellite's `images.py`, using only the standard library's `struct` module - the
same dependency-free promise as the rest of Photo's format handling, and unrelated to
whether Pillow happens to be installed for thumbnails (see below). A `library.json` written
before this existed still loads: a record without a `metadata` object is filled in with all
fields `null` when read, in memory only, so the file on disk is never rewritten just for
being loaded.

Mission Control's photo viewer shows whatever of this is present - dimensions and megapixels
next to size and format, camera and lens details, and, when GPS coordinates are present, a
link to the location on OpenStreetMap.

## Thumbnails

The gallery is served scaled-down copies rather than originals. A thumbnail is rendered on
first request and cached; afterwards it is served from disk.

Rendering a thumbnail is the one thing the standard library cannot do for JPEG or WEBP, so
the Satellite uses [Pillow](https://pypi.org/project/pillow/) **when it is installed** and
falls back to serving the original otherwise. StarCore does not require it: the library,
the import, the metadata and the gallery all work either way, and the Mission Control page
says which of the two is in use. Install it with `pip install pillow` to enable thumbnails.

A thumbnail that fails to render falls back to the original for that photo alone, so one
unusual file cannot empty the gallery.

## API

Everything the page needs is served below the Satellite:

```
GET  /api/satellites/photo/library            library summary
GET  /api/satellites/photo/photos             every photo, newest first
GET  /api/satellites/photo/photos/<id>        one photo's metadata
GET  /api/satellites/photo/thumbnails/<id>    cached thumbnail
GET  /api/satellites/photo/originals/<id>     the stored original
POST /api/satellites/photo/scan               preview a directory  {"source": "..."} (optional - see below)
POST /api/satellites/photo/import             import a directory   {"source": "..."} (optional - see below)
GET  /api/satellites/photo/configuration      current settings (sync_host, sync_port, photo_directory)
POST /api/satellites/photo/configuration      change one            {"key": ..., "value": ...}
GET  /api/satellites/photo/albums                       every album, with a photo count and cover photo
GET  /api/satellites/photo/albums/<id>                  one album, with its photos in full
POST /api/satellites/photo/albums                       create one             {"name": "..."}
POST /api/satellites/photo/albums/<id>                  rename it              {"name": "..."}
POST /api/satellites/photo/albums/<id>/delete           delete it
POST /api/satellites/photo/albums/<id>/photos           add a photo            {"photo_id": "..."}
POST /api/satellites/photo/albums/<id>/photos/remove    remove a photo         {"photo_id": "..."}
```

Photos are only ever addressed by identifier. An identifier that is not in the index is a
404, and no request can name a path, so nothing outside the managed storage can be reached
through these routes. Import is the one route that accepts a path from the caller: it is
validated as an existing directory, it may not point inside the library itself, and it only
ever reads. There is no endpoint that browses or serves arbitrary files.

The album routes are all `GET`/`POST` - never `PUT`, `PATCH` or `DELETE` - because that is
all the Core's own request handler ever routes to a Satellite (see `docs/satellites.md`);
rename, delete and remove-photo are expressed as `POST` sub-paths rather than idiomatic REST
verbs for exactly that reason, the same way Photo's own `"configuration"` route already
updates settings with a `POST`. There is no separate endpoint for the Map tab or the
photo-details location panel: both are built entirely client-side from the `gps_latitude`/
`gps_longitude`/`gps_coordinates` fields already present on every photo returned by
`/photos` and `/photos/<id>`, so no new backend endpoint was needed for either.

## Mission Control

The Photo page is a Photo Library with three tabs - **Photos**, **Albums** and **Map** -
sharing one topbar, one summary and the same Config (gear) button described in
"Configuring Photo Sync" below; switching tabs never touches sync or import state, and the
existing photo viewer (full image, metadata, keyboard navigation) opens from a photo in any
of the three.

### Photos

The library summary, a gallery of thumbnails and the import panel, same as before. Selecting
a photo opens the viewer with the full image, its metadata, and keyboard navigation (left,
right, escape).

Because a browser cannot read a folder on the machine running StarCore, the import panel
asks for a path on that machine rather than pretending to open a local folder picker. The
panel scans first, so the folder can be previewed before anything is copied. When a default
`photo_directory` is configured (see below) and the field hasn't been typed into yet, the
panel pre-fills it so importing from the usual place doesn't mean retyping the same path
every time - typing a different path always overrides the default for that one import.

When at least one photo carries camera/device EXIF metadata (`camera_make`/`camera_model`),
an "All / By camera" toggle appears above the gallery to group photos by device; a photo with
no camera metadata still appears, grouped under "Unknown camera", rather than being hidden.
The toggle stays hidden entirely when no photo in the library has that metadata at all - it
is never shown just to sit empty, and nothing is fabricated for a photo that lacks it.

### Albums

User-created groupings of photos, entirely separate from the library index (see "Albums"
below for the storage and API this is built on). "New album" creates one; each album card
can be renamed or deleted from a hover action; opening a card shows its photos and an "Add
photos" picker that toggles membership for any photo in the library, live, without leaving
the picker. Deleting an album, or removing a photo from one, never touches the photo itself
or anything under `data/photos/`.

### Map

An interactive map of every photo that carries GPS metadata, built with
[Leaflet](https://leafletjs.com/) (see "Map" below for why this is the one satellite that
depends on an external library, and how). Photos without location data are simply left off
the map - there is no requirement that every photo have one, and the tab shows a plain
notice instead of an empty or broken map when nothing in the library has a location yet.
Close-together photos are grouped into a single cluster marker (with a count badge) that
splits apart on zoom, rather than piling up unreadable overlapping pins. Selecting a marker
opens the photo viewer for the photo(s) at that location.

### Photo details - location

The existing photo viewer's info panel now also shows the photo's location: a small map with
a marker when the photo has GPS coordinates (visually consistent with the Map tab, using the
same Leaflet integration), or "Location unavailable" - never a blank or broken map - when it
does not.

## Command

```
photo                          summary of the library
photo list [count]             the most recent photos
photo import <directory>       import a directory
photo config                   show Photo Sync's current settings
photo config <key> <value>     change one, e.g. photo config sync_port 8090
```

`photo config` reads and writes the same settings, the same `config.toml`, as Mission
Control's Config button on the Photo card - see "Configuring Photo Sync" below.

## Phone synchronization

A phone can send photos straight into the library over the local network.

The Satellite runs its own small listener, separate from Mission Control. Reaching StarCore
from a phone means binding to the local network, and keeping the two apart means that
exposes one token-protected upload endpoint rather than the whole Core - Mission Control,
the console and shutdown stay on the loopback address.

### Configuration

```toml
sync_enabled = true
sync_host = "127.0.0.1"    # set to "0.0.0.0" to let phones on the local network reach it
sync_port = 8081
sync_token = ""            # generated and stored in the library on first start when empty
sync_max_bytes = 67108864  # 64 MB per upload
```

The default is deliberately local-only: the listener runs, but nothing outside the machine
can reach it until `sync_host` is changed. When `sync_token` is empty a token is generated on
first start and kept in `data/sync_token`, so a phone set up once keeps working across
restarts.

### Configuring Photo Sync

`sync_host` and `sync_port` are editable without hand-editing `config.toml`: open the Photo
card on the Satellites page and use its Config (gear) button, or use the same topbar button
on Photo's own Mission Control page, or run `photo config` from the CLI (see "Command"
above). This is Photo's own use of the Satellite configuration mechanism described in
`docs/satellites.md` under "Exposing configuration" - the Core has no notion of `sync_host`
or `sync_port` by name; Photo is simply the first Satellite to name a `"configuration"`
route.

`config.toml` remains the source of truth either way - a change made through Mission Control
or the CLI is validated (a host may not be empty, a port must be a whole number from 0 to
65535) and written back to the same file, the same comment-preserving edit `photo config`
and the Core's own `config` command both use, so nothing else in the file is disturbed.

Because Photo Sync's listener is a background service independent of Mission Control's own
API server (see "Running a background service" in `docs/satellites.md`), a validated change
restarts it immediately - `sync_port 8090` takes effect right away, not on the next StarCore
restart. Mission Control and the CLI both report what actually happened: a successful
restart names the address it is now listening on, and a port already in use is reported as
such rather than silently pretending the change took effect. `sync_port = 0` (let the OS
choose a port) is never reported as a pending restart merely because the live bound port
differs from the literal `0` on disk - that mismatch is the point of `0`, not a stale value.

### Configuring the default photo directory

`photo_directory` is edited through the same Config button, page and CLI command as
`sync_host`/`sync_port` above - it is simply another setting on Photo's own
`"configuration"` route. Unlike the sync listener, there is nothing running for this setting
to fall out of sync with: a saved value applies to the very next `scan` or `import` that
doesn't name its own `source`, so it is never reported as a pending restart.

A value must be an absolute path, or start with `~` (expanded to the user's home directory
at scan/import time) - a relative path is rejected before anything is written. Leaving it
empty (the default) means `scan` and `import` always require a `source` explicitly. A
directory that has since become missing or inaccessible is never a crash: the same
validation `scan`/`import` already perform on an explicit `source` (see "Import" above)
applies just the same to the configured default, and is reported as a normal `400` error
naming the problem.

Mission Control's Config modal also offers a "Browse…" button next to this field, backed by
the FileExplorer Satellite (see `docs/satellites.md`, "Exposing configuration"), so a
directory can be picked instead of typed - the button only appears when FileExplorer is
present and enabled; the field still accepts a typed path either way.

### Sending a photo

```
POST http://<host>:8081/upload?token=<token>
X-Photo-Filename: holiday.jpg      (optional, percent-encoded, metadata only)
<the image bytes as the request body>
```

The token may also be sent as an `X-StarCore-Token` header. The body is the raw file - there
is no multipart parsing to get wrong, and it is what phone automation tools send most easily.
Responses are JSON:

```json
{ "status": "imported", "photo": { ... } }
{ "status": "duplicate", "photo": null }
{ "status": "error", "error": "..." }
```

`400` for an empty or truncated upload, `401` for a bad token, `411` without a
`Content-Length`, `413` over the size limit, `415` for something that is not a supported
image. An upload is written aside first and only reaches the library once it has arrived
whole and been recognised, so an interrupted transfer leaves nothing behind. The filename is
metadata only - the stored name always comes from the content digest - and it is reduced to
its last path segment, so it cannot point anywhere.

### From a phone

Opening `http://<host>:8081/?token=<token>` on a phone serves a small page for picking
photos and sending them, which needs no app installed. Mission Control's Photo page shows
that address under "Phone sync", along with what has been received.

For automatic synchronization, point a phone automation tool at the same endpoint - iOS
Shortcuts ("Get contents of URL", POST, request body: file) and Android automation apps can
both send a file that way when a photo is taken. StarCore deduplicates by content, so
re-sending a photo is always safe.

## Ingestion

`PhotoLibrary.add_file()` takes a single file into the library and returns its record, or
`None` when the image is already stored. Both directory import and phone sync are built on
it: everything that enters the library goes through the same storage layout, identifiers,
deduplication and metadata. A future dedicated phone client only has to reach the same
endpoint, or call `add_file()` directly.

## Albums

Albums are a second, independent index (`albums.py`, `data/albums.json`) alongside the
library's own `library.json` - a deliberate second module within the same Satellite package
(see `docs/satellites.md`, "Satellites with several modules") rather than a new Satellite or
a new database system, since an album is nothing but metadata: a name and an ordered list of
photo ids.

An album never stores a copy of a photo, and never stores a filename - only the same stable,
content-addressed identifier the library already assigns each photo (see "Storage" above).
That means an album keeps pointing at the right photo even if its filename metadata changes,
and deleting an album, or removing a photo from one, never touches anything under
`data/photos/` or `data/thumbnails/`. If a photo id an album still lists is no longer in the
library (nothing currently deletes a photo from the library itself, but a future release
might), it is simply skipped wherever that album's photos are resolved, and quietly dropped
from the album the next time it is fetched through the API - the index on disk is never
rewritten just for being read, the same tolerant-loading convention `library.json` already
uses.

`albums.json` is written the same way `library.json` is: a new version is written to a
`.part` file and only then atomically moved into place, so an interrupted write can never
leave a half-written index behind.

## Map

The Map tab and the photo-details location panel are the first (and so far only) part of
Photo, and of StarCore's Mission Control generally, to depend on an external
JavaScript library rather than the zero-dependency plain HTML/CSS/JS the rest of Mission
Control is built from (see `docs/mission_control.md`) - client-side interactive maps are
not something that can reasonably be built from scratch, and no mapping library already
existed anywhere in the repository (the previous Photo page only ever linked out to
OpenStreetMap for a single photo).

[Leaflet](https://leafletjs.com/) is loaded lazily, only when the Map tab is opened or a
photo with GPS metadata is viewed, from a CDN (`unpkg.com/leaflet@1.9.4`) in the end user's
own browser - not vendored into the repository, and not fetched by anything running on the
server. Map tiles come from the public OpenStreetMap tile servers the same way. This means:

- both require the browser to have internet access; StarCore itself needs none for any of
  its own functionality, and nothing else in Photo or elsewhere depends on this
- if the load fails (no internet access, the CDN or tile servers unreachable, etc.), the Map
  tab and the location panel both show a plain, clearly worded notice explaining that the
  map library could not be loaded, rather than an empty panel, a broken layout or a crash
- once loaded, Leaflet is reused for the rest of the session rather than reloaded per photo
  or per tab switch

No Leaflet plugin is used for marker clustering; it is a small amount of first-party code
that groups nearby photos by rounding their coordinates to a zoom-dependent precision and
drawing one marker at the group's centroid, redrawn as the map is panned or zoomed - kept
this way specifically to avoid adding a second external dependency for what a few dozen
lines of arithmetic already does. Markers are custom-drawn (`L.divIcon`) rather than
Leaflet's default marker images, for the same reason: it avoids depending on - and needing to
host or reference - Leaflet's default marker image assets at all.

The map's dark, deep-space appearance is a CSS filter (invert, hue-rotate, reduced brightness
and saturation) applied only to the tile layer, recolouring the same standard OpenStreetMap
tiles everyone else uses rather than depending on a separate, often paid, dark-tile provider.
Markers, popups and Leaflet's own controls are left in their normal colours on top of the
recoloured tiles, so they stay clearly visible against it.
