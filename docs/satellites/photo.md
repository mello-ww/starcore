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
storage = "data"      # relative paths are resolved inside the satellite
thumbnail_size = 480  # longest edge, in pixels
```

`storage` may be an absolute path, which is how the library is moved to another disk.

`source_paths` and `sync_default_path` (see "Albums" below) map a phone's own folder structure
onto the library:

```toml
source_paths = [
    { id = "d551af858188", phone_path = "/Pictures/Screenshots", server_path = "screenshots", name = "Screenshots" },
]
sync_default_path = "camera"  # where a synced file lands when no source_paths entry matches its phone folder
```

The phone path and the server path are never assumed to be the same string - a phone folder is
whatever the phone's own camera-roll grouping calls it (`/Pictures/Screenshots`,
`/Pictures/Snapchat`, ...); the server path is always relative to the library's own storage and
becomes that mapping's physical album (see "Albums"). `id` is generated the first time a mapping
is saved if not given.

## Supported formats

Photos: JPEG, PNG and WEBP. Format, width and height are read from the file header by the
Satellite's own `images.py`, using only the standard library.

Videos: MP4, MOV/QuickTime and 3GP (the ISOBMFF/"box" family - practically everything an
Android or iPhone camera actually records). Format, duration and display dimensions are read
from the file's own container boxes (`ftyp`, `mvhd`, the video track's `tkhd`) by the
Satellite's own `videos.py`, using only the standard library - the same dependency-free
promise as `images.py`. WEBM is intentionally not supported: a full Matroska/EBML parser is
substantial scope beyond what phone cameras actually produce.

What kind of file something is, is always decided by looking at its bytes, never by its file
extension or name - the same file arrives with an extensionless temporary name over phone
sync (see "Phone synchronization" below), so trusting a name would silently break every video
sent that way. `add_file()` tries `images.probe()` first, then `videos.probe()`; whichever one
recognises the content decides the rest.

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

## Metadata

Every record (photo or video) also carries `media_type` (`"photo"` or `"video"`) and
`duration` (seconds, only ever non-null for a video). A `library.json` written before video
support existed still loads: a record missing these is backfilled with `media_type: "photo"`,
`duration: null` in memory when read, the same convention `metadata` itself already used - the
file on disk is never rewritten just for being loaded.

For every photo the index records the identifier, the original filename, the stored path,
the file size, width, height, format and the import timestamp. `captured_at` is filled from
the EXIF `DateTimeOriginal` field (falling back to `DateTime`) when the file carries one;
photos without EXIF simply have no capture date. Nothing is guessed or invented.

`width`/`height` are `null` for a video whose display size couldn't be read from its container
(a track StarCore couldn't parse) - never guessed. `metadata` (below) is photo-only; a video's
record simply carries it with every field `null`.

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

A video's thumbnail is a single frame, rendered by shelling out to
[ffmpeg](https://ffmpeg.org/) (`videos.thumbnail()`) **when it is installed**, seeking to
roughly the midpoint of the clip (capped at one second in, for a very short video). Unlike a
photo, a video has no original image to fall back to when ffmpeg isn't installed or a
particular file can't be read - its thumbnail and preview routes report `404` in that case
(with a message naming ffmpeg as the reason) rather than serving anything, and the gallery
shows a plain video placeholder. Install ffmpeg through your OS's package manager
(`apt install ffmpeg`, `brew install ffmpeg`, ...) to enable video thumbnails and previews;
the video is still stored, still playable through its own `originals/<id>` route, and still
fully manageable (trash/restore/erase) either way.

## API

Everything the page needs is served below the Satellite:

```
GET  /api/satellites/photo/library            library summary
GET  /api/satellites/photo/photos             every active photo, newest first
GET  /api/satellites/photo/photos/<id>        one photo's metadata
GET  /api/satellites/photo/thumbnails/<id>    cached thumbnail
GET  /api/satellites/photo/originals/<id>     the stored original
POST /api/satellites/photo/scan               preview a directory  {"source": "..."}
POST /api/satellites/photo/import             import a directory   {"source": "..."}
GET  /api/satellites/photo/configuration      current sync_host/sync_port/trash_retention_days/source_paths/... settings
POST /api/satellites/photo/configuration      change one            {"key": ..., "value": ...}
POST /api/satellites/photo/sync_upload        upload one photo/video, authenticated (see "Real automatic phone sync")
GET  /api/satellites/photo/albums             every physical album, Favorites, and every custom album
GET  /api/satellites/photo/albums/<id>        one album's photos ("physical:<id>" for a physical album)
POST /api/satellites/photo/albums             create a custom album  {"name": ...}
POST /api/satellites/photo/albums/<id>        rename a custom album  {"name": ...} (rejected for Favorites/physical)
POST /api/satellites/photo/albums/<id>/delete    delete a custom album (rejected for Favorites/physical)
POST /api/satellites/photo/albums/<id>/photos           add a photo   {"photo_id": ...}
POST /api/satellites/photo/albums/<id>/photos/remove    remove a photo {"photo_id": ...}
GET  /api/satellites/photo/trash              what's in the recycle bin, and its retention period
POST /api/satellites/photo/trash/<id>         move an active photo to the recycle bin
GET  /api/satellites/photo/trash/<id>/thumbnail   preview a trashed photo's thumbnail
GET  /api/satellites/photo/trash/<id>/original    preview a trashed photo's original
POST /api/satellites/photo/trash/<id>/restore     move a photo back out of the recycle bin
POST /api/satellites/photo/trash/<id>/erase       permanently delete a photo that is in the recycle bin
```

A photo id that is currently in the recycle bin behaves as if it doesn't exist anywhere except
the `trash` routes above - `photos/<id>`, `thumbnails/<id>` and `originals/<id>` all 404 for it,
exactly as they would for a photo that had actually been deleted. It stays a member of any album
it was in, so restoring it puts it right back where it was; only `erase` (directly, or the
automatic purge below) actually drops it from an album.

Photos are only ever addressed by identifier. An identifier that is not in the index is a
404, and no request can name a path, so nothing outside the managed storage can be reached
through these routes. Import is the one route that accepts a path from the caller: it is
validated as an existing directory, it may not point inside the library itself, and it only
ever reads. There is no endpoint that browses or serves arbitrary files.

## Mission Control

The Photo page shows the library summary, a gallery of thumbnails and an import panel.
Selecting a photo opens a viewer with the full image, its metadata, and keyboard navigation
(left, right, escape).

Because a browser cannot read a folder on the machine running StarCore, the import panel
asks for a path on that machine rather than pretending to open a local folder picker. The
panel scans first, so the folder can be previewed before anything is copied.

A video's tile in the gallery carries a play badge and its duration; opening it plays it
in place of the still image the viewer otherwise shows, with the same metadata panel (minus
dimensions, plus duration) as a photo.

## Mobile app

StarCore's own mobile app recognizes "Photo" by name (rather than falling back to the generic
declarative screen every other Satellite gets - see "Exposing a mobile interface" in
`docs/satellites.md`) and gives it a dedicated gallery: Library, Albums, Map and Search, as
segments of one screen, with Photo configuration reached separately (see below) rather than as
a segment of its own. All of it is built on exactly the routes above and the same Albums model
documented there - there is no second implementation of the library, albums, the recycle bin,
or ingestion for mobile.

Videos are unified with photos throughout: the same grid (with a play badge and duration on a
video's thumbnail, grouped by month and, on mobile, pinch-to-zoom to change how many columns
show), the same full-screen viewer (swiping between photos and videos alike, with pinch-to-zoom
on a still image), and the same recycle bin. The viewer plays a video in place with its own
tap-to-pause controls; only the page actually on screen ever has a real player mounted, so
swiping away always stops playback. A photo or video's details panel (web and mobile alike)
shows its stored filename and - when it has one - its physical album's server path, so where a
file actually came from is never a mystery.

Automatic phone sync (below) has no segment of its own: its enable/disable, Wi-Fi-only, "Sync
now" and status live inside the Photo configuration screen, alongside `source_paths`,
`sync_default_path` and every other Photo setting - see "Real automatic phone sync" and
"Configuration" above.

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
sync_max_bytes = 536870912 # 512 MB per upload - phone video needs more headroom than photos ever did
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

For automatic synchronization from *any other* phone automation tool, point it at the same
endpoint - iOS Shortcuts ("Get contents of URL", POST, request body: file) and Android
automation apps can both send a file that way when a photo is taken. StarCore deduplicates by
content, so re-sending a photo is always safe.

### Real automatic phone sync

StarCore's own mobile app does this automatically, without any automation app to set up: new
photos and videos taken on the phone are found and uploaded on their own, in the background,
Google-Photos-style. This is a *second* way to reach the same ingestion - never a second
ingestion implementation - built for the case the standalone listener above doesn't cover
well: a phone that only ever reaches StarCore through its main HTTPS address (see
`docs/deployment.md`), with no separate port or per-phone token to set up.

It works through `POST /api/satellites/photo/sync_upload?filename=...` (see the API table
above) - authenticated exactly like every other mobile API call (the app's own logged-in
session), and calling `sync.accept_authenticated_upload()`, which itself calls the very same
`SyncService.accept()` the standalone listener's `SyncHandler` calls. Both paths share one
`SyncService` per running Satellite, so Mission Control's Sync section (and `photo config`'s
counts) reflect uploads made either way, and this authenticated route is always available
whenever `sync_enabled = true`, whether or not the standalone listener's own local-network
socket happened to bind.

On the phone, turning "Automatic sync" on (from the Photo configuration screen - see "Mobile
app" above) does three things:

- **Periodic background check.** Roughly every 15 minutes (the shortest interval Android's
  WorkManager honors reliably), via `react-native-background-fetch`, the app looks for photos
  and videos newer than the last one it already offered this server and uploads them. This
  runs even if the app isn't open (swiped away, or closed by the system), and even after a
  reboot. It does not run after an explicit "Force stop" from Android's app settings: Android
  then blocks all of the app's background work until the app is opened again, which also
  resumes the schedule.
- **Immediate sync on open.** The same check also runs right away whenever the app is opened,
  so there's no waiting for the next periodic tick after taking a photo and immediately
  checking the app.
- **Wi-Fi only**, optionally - "where Android allows it reliably" (per the periodic check's
  own WorkManager network constraint). This applies to the periodic background check; opening
  the app can still sync over cellular, since there is no reliable way to gate that path on
  connectivity without a dedicated network-info library the app doesn't otherwise need.

A few things are true regardless of which of the above triggered a given sync:

- **Deduplication** is the server's own content-hash dedup (`PhotoLibrary.add_file()`) - the
  same one manual imports and the standalone listener already rely on. The app also keeps a
  lightweight local cursor (the timestamp of the newest asset already offered) purely so it
  doesn't re-scan and re-offer its whole camera roll on every check; that cursor is never what
  makes dedup *correct*, only what makes it efficient - re-uploading something StarCore
  already has is always harmless.
- **Retry.** If an upload fails (StarCore unreachable, a network blip, ...), the app stops
  that batch right there rather than skipping ahead, so the failed asset (and anything newer
  that hasn't been tried yet) is retried on the next check rather than silently skipped.
- **Never deletes anything from the phone.** Sync only ever reads the camera roll and sends
  copies onward - exactly like every other way of getting a photo into StarCore.
- **Per-server.** A phone with more than one StarCore server configured tracks sync
  independently for each one (its own on/off, Wi-Fi-only setting, and cursor), the same way
  the app's offline cache and session are already kept per server.

## Albums

The Albums section shows three different kinds of grouping side by side, visually
distinguished but backed by the one album model below - there is no separate "physical album"
or "favorites" system, just a `kind` field on the same shape every album already had.

- **Physical.** One per `source_paths` mapping (see "Configuration" above) - created the moment
  that mapping is saved, even before any photo has landed in it. Membership is never stored:
  it's computed from each photo's own `physical_path` (set once, at import time, by
  `sync.accept_authenticated_upload()` resolving the phone folder against `source_paths`/
  `sync_default_path` - see `configuration.resolve_physical_path()`). The path is the source of
  truth, so nothing here can drift out of sync with it, and there is nothing to add or remove a
  photo from directly (`POST /albums/physical:<id>/...` is rejected - edit the source path
  instead). A photo synced with a phone folder that matches no mapping still gets a physical
  album: `sync_default_path`. Only a photo imported some other way (a directory scan/import, or
  the standalone local-network listener) has no physical album at all - the same as before this
  existed. `GET /albums/physical:unsorted` is a standing catch-all for a physical_path whose
  mapping was since removed; it disappears when nothing needs it.
- **Favorites.** A fixed, always-present virtual album (`id: "favorites"`) - the same
  add/remove-photo routes as any other album, just protected from rename and delete. Favoriting
  a photo is `POST /albums/favorites/photos {"photo_id": ...}`; never moves or copies the file.
- **Custom (virtual).** What "Albums" already meant before this: a plain reference list a
  person creates and names themselves (`POST /albums {"name": ...}`). Independent of any
  physical album - a photo keeps belonging to its physical album (if it has one) no matter how
  many custom albums it's also added to, and being in a custom album never changes where the
  file is stored.

The Recycle bin is presented in the same Albums section on both web and mobile, but it is not
part of this album model at all - it's still the separate `trash` resource described below,
included in the Albums screen purely as a UI convenience so all four kinds live in one place.

## Ingestion

`PhotoLibrary.add_file()` takes a single file (photo or video) into the library and returns
its record, or `None` when the exact same content is already stored. Directory import, the
standalone phone sync listener, and the mobile app's authenticated background sync are all
built on it: everything that enters the library goes through the same storage layout,
identifiers, deduplication and metadata, whichever door it came in through. What kind of file
it is, is decided from its content (see "Supported formats"), never from its name - the one
thing that makes phone sync's extensionless temporary uploads work at all.

## Recycle bin

Deleting a photo never removes it immediately. It moves to a recycle bin, where it stays
recoverable for a configurable number of days before being erased for good.

```toml
trash_retention_days = 30  # days a deleted photo stays in the recycle bin before being erased
```

Moving a photo to the bin (`POST trash/<id>`) makes it disappear from the library exactly as
if it had been deleted - `photos`, `thumbnails`, `originals` and every album it belongs to all
stop showing it - but its stored original and thumbnail are untouched, and it keeps its place
in any album's `photo_ids` so restoring it (`POST trash/<id>/restore`) puts it right back
where it was.

Nothing on disk changes until either the photo is restored, it is explicitly erased
(`POST trash/<id>/erase`, only ever available for a photo already in the bin - there is no way
to erase an active photo directly, so a permanent delete always passes through the bin first),
or its time runs out. The purge is lazy rather than a background timer: whenever the recycle
bin is listed (`GET trash`, which the Mission Control page's Trash tab and the mobile app's Bin
segment both poll), anything past its retention period is erased first, so nothing that shows
up in the bin is ever actually gone already, and nothing keeps running when Photo isn't being
asked about it.

A video moves through the bin exactly like a photo - the same routes, the same retention, the
same lazy purge - there is no separate recycle bin implementation for either media type or
either client (Mission Control, mobile).

`trash_retention_days` is edited the same way as `photo_directory` - through the Photo card's
Config button, Photo's own topbar Config button, or `photo config trash_retention_days <days>`
from the CLI - and, like `photo_directory`, it has no running listener to restart, so a change
takes effect the next time the bin is listed or purged.
