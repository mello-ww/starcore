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
extension or name - an upload is written aside under a temporary name with no extension before
it reaches the library, so trusting a name would silently break every video sent that way. `add_file()` tries `images.probe()` first, then `videos.probe()`; whichever one
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

An original served in place of a thumbnail is sent with `Cache-Control: private, no-cache`,
never the week-long cache a rendered thumbnail gets: otherwise browsers and the app would keep
the full-size files under the thumbnail URL after Pillow is installed. When Pillow (photos) or
FFmpeg (video frames) is missing, the Photos page says so above the tabs.

With uv, install Pillow with **all** the extras you use, for example
`uv sync --extra thumbnails --extra encryption`: `uv sync` removes extras that aren't named,
and a Locked Folder that is encrypted stays locked without `cryptography`.

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
POST /api/satellites/photo/scan               preview a directory  {"source": "..."}; the answer includes a readable "message"
POST /api/satellites/photo/import             import a directory   {"source": "..."}; the answer includes a readable "message"
GET  /api/satellites/photo/configuration      current source_paths/sync_default_path/trash_retention_days/... settings
POST /api/satellites/photo/configuration      change one            {"key": ..., "value": ...}; the answer's "message" says what was saved
GET  /api/satellites/photo/albums             every physical album, Favorites, and every custom album
GET  /api/satellites/photo/albums/<id>        one album's photos ("physical:<id>" for a physical album)
POST /api/satellites/photo/albums             create a custom album  {"name": ...}
POST /api/satellites/photo/albums/<id>        rename a custom album  {"name": ...} (rejected for Favorites/physical)
POST /api/satellites/photo/albums/<id>/delete    delete a custom album (rejected for Favorites/physical)
POST /api/satellites/photo/albums/<id>/photos           add a photo   {"photo_id": ...}, or picked media {"items": [references]}
POST /api/satellites/photo/albums/<id>/photos/remove    remove a photo {"photo_id": ...}
GET  /api/satellites/photo/gallery            the library shaped for ui.json's shared gallery (read-only); ?group=month
                                              (the default), camera (alphabetical, unknown last, each newest first) or all
GET  /api/satellites/photo/gallery/albums     every album as a tile with its cover: Favorites pinned first, then each
                                              enabled Satellite Photo hosts (section_of, from the Engine's registry: its
                                              title and icon, a "section" to open, nothing about what it holds), the
                                              phone's folders (together under "Folders"), then custom albums ("Albums")
GET  /api/satellites/photo/gallery/albums/<id>   one album's photos in the album's own order, for the shared gallery
GET  /api/satellites/photo/gallery/trash      the recycle bin, with the days each item has left ("left")
GET  /api/satellites/photo/gallery/import     the default import folder and the formats an import takes in
GET  /api/satellites/photo/gallery/settings   what the shared Settings page edits: source_paths (each with its id), trash_retention_days,
                                              photo_directory and sync_default_path
GET  /api/satellites/photo/media?kinds=       media.gallery's list: what a media picker may offer
GET  /api/satellites/photo/media/resolve/<id>  media.gallery's resolve: {id, kind} for a photo of the active library, 404 otherwise
GET  /api/satellites/photo/media/original/<id> media.gallery's original, for the server alone (403 to a client): the stored original
POST /api/satellites/photo/media/release      media.gallery's release, for the server alone: {id, sha256}; the item leaves the library and its albums
POST /api/satellites/photo/media/adopt        media.gallery's adopt, for the server alone: ?name=&modified= and a raw body -> {id, kind, added}
GET  /api/satellites/photo/gallery/search?q=&kind=   photos and albums matching a search, for the shared Search page
GET  /api/satellites/photo/gallery/map        every photo with a location, for the shared Map page;
                                               ?overview=1 its count and bounds only; ?bbox=&zoom= what is in an area
GET  /api/satellites/photo/trash              what's in the recycle bin, and its retention period
POST /api/satellites/photo/trash/<id>         move an active photo to the recycle bin
GET  /api/satellites/photo/trash/<id>/thumbnail   preview a trashed photo's thumbnail
GET  /api/satellites/photo/trash/<id>/original    preview a trashed photo's original
POST /api/satellites/photo/trash/<id>/restore     move a photo back out of the recycle bin
POST /api/satellites/photo/trash/<id>/erase       permanently delete a photo that is in the recycle bin
GET  /api/satellites/photo/backup/status      media.sync's status: what a backup takes, and this caller's record
POST /api/satellites/photo/backup/check       media.sync's check: {items: [{sha256, size}]} -> {known, wanted}
GET  /api/satellites/photo/backup/upload/<sha256>    media.sync's upload: the offset held for this file
POST /api/satellites/photo/backup/upload/<sha256>    ?offset=&size=&name=&folder=&taken= and the raw bytes from offset
GET  /api/satellites/photo/backup/devices     media.sync's devices: who backs up here (refused to a device credential)
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

Photo's shared interface (below) is what the app opens by default. Its previous screens, kept
in Developer Mode until they are retired (`docs/remaining-work.md`), are a dedicated gallery: Library, Albums, Map and Search, as
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

The Photo configuration screen holds `source_paths`, `sync_default_path` and every other Photo
setting - see "Configuration" above. The phone's backup gets its own screen with
the app's side of it (see "Phone backup").

## Shared interface

Photo also describes its Library, Albums, Search, Map, recycle bin and folder import in a
`ui.json` (UI contract 1.2), drawn by both clients' shared blocks - the first step of moving
Photo off client code of its own. Since M6 it is Photo's **default** interface on both
clients. Photo's own page and screens stay until the shared one is validated, and Developer Mode
opens them instead (on the web, the button beside the Satellite's title; in the app, "Own
screen (previous)" on Photo's card in Satellites). The released Alpha app ignores the document
and keeps opening Photo's own screens.

What it covers:

| | Photo's own page and screens | Shared interface |
| --- | --- | --- |
| Library grid, newest first, by month; video badge and duration | yes | yes |
| Group the Library by camera, or not at all ("All") | web only | yes, both clients (Group by: Month, Camera, All) |
| Viewer: full image, video playback, previous and next, details | yes | yes (no OpenStreetMap link) |
| Viewer: pinch to zoom an image (Android) | yes, two fingers to pan | yes, one finger to pan while zoomed, double tap to zoom |
| Favourite and unfavourite; move to the recycle bin | yes | yes, from the viewer and from a selection; favourite also from the heart on each tile (Library, Search, an album) |
| Download and share a photo or video | Android: Share sent a bare link | yes, from every viewer: the file itself, saved (the web; Android 10 and later, to Downloads) or shared (Android; the web where the browser can share files) |
| Albums: physical, Favorites, custom, with covers; open an album | yes | yes, with Favorites pinned at the top of Folders |
| Create, rename, delete a custom album; remove a photo from it | yes | yes |
| Add a photo to a custom album | yes, from a photo | yes, from the album: "Add photos" opens the client's media picker |
| Recycle bin: restore, delete for good, retention | yes | yes, from the viewer and from a selection |
| Recycle bin: days each item has left | yes | yes, under each tile and in the viewer |
| Album order: the order photos were added (a folder's own order) | yes | yes |
| Grouping by camera | web only | no |
| Thumbnail size | Android: pinch, not remembered | Android: pinch; web: small, medium, large; remembered per grid |
| Search: file name, camera, lens, date; matching albums | Android only | yes, both clients, with a Photos/Videos filter |
| Map: located photos, opening the viewer | yes | yes (see below) |
| Map clustering | web only, by rounded coordinates | both clients, a grid about 64 px wide on screen |
| Import from a folder on the server: check, then import | web only | yes, both clients ("Import from a folder" on Library) |
| Settings: phone folders (`source_paths`), the default album for synced photos, the recycle bin's retention, the default import folder | yes | yes, both clients: Settings on Albums, one form each, the phone folders as repeatable rows (see below) |
| Phone sync | removed (S0) | removed (S0); its new form comes in S1 to S4 of [the parity audit](../photos-parity-audit.md) |
| Locked Folder | yes | its tile among the folders on Albums (a lock, shown while the Locked Folder is enabled) opens it with the `section` action: its shared interface, its only one ([the Locked Folder](locked_folder.md#shared-interface)) |
| Move a photo into the Locked Folder | yes, from the viewer | yes: the viewer (Library, Search, Map, an album) and a selection (Library, an album), through the secure action - see below |
| Offline cache of the library (Android) | yes, the whole list (metadata only) | yes: Library, Albums and an album, with up to 600 items each (`offline` pages, see the UI contract's "Offline pages"), only the fields they show, and never an item's GPS location or its folder on the server; never the recycle bin, Search or Map |

Search looks in the same fields as the app's own Search tab, on the server
(`gallery/search`): nothing is listed until there is text to look for, a photo in the recycle bin
is never found, and album names are matched too. The Map page (`gallery/map`) places the same
photos as the Map tabs - only those whose GPS metadata is a valid pair; no location is ever
requested from the device. On the web it uses the same Leaflet and OpenStreetMap tiles as the
Map tab, recoloured for the dark theme. On Android it uses react-native-maps like the app's own
Map tab, so both need a Google Maps key in `android/gradle.properties` to draw anything; without
one the map area stays blank and the Library, Search and viewer work as usual. Differences that
remain: on Android a cluster opens the viewer directly (the web shows its thumbnails first), and
the web's single-photo popup is replaced by opening the viewer at once.

**Settings** (Albums' Settings button) reads `gallery/settings` and saves each setting through
the `configuration` route, one form each, as Photo's own page and screen do: the phone folders
(`source_paths`) as a form field of repeatable rows (UI contract 1.2, "Repeatable rows"), each
row the folder on the phone, the folder in the library and an optional album name; the default
album folder for synced photos (`sync_default_path`); the days a deleted item stays in the
recycle bin; the default folder an import starts from. A row keeps the id it was read with, so
a mapping that is edited keeps its album's id; a new row gets one from `configuration.py`. A
refused value (an absolute or `..` path in the library, a phone folder mapped twice, fewer than
one day) changes nothing and its error shows as the form's notice.

The Locked Folder's tile uses the `section` action
(`{"section": "$.section"}`), and Photo's document names no Satellite it hosts: the albums route
lists them from the Engine. It opens the Locked Folder's shared interface, by itself (on the
web at `#/satellite/Photo/LockedFolder`, in the app pushed over Photos' screen), which asks for
its PIN or biometrics, locks again on leaving and blocks screenshots on Android. Photo's
document never reaches the vault's routes or media
([the Locked Folder](locked_folder.md#shared-interface)).

**Move to Locked Folder** is the contract's `secure` action (`media.vault` / `move_in`), on the
viewer and on a selection. The document names neither the Locked Folder nor a route.
1. The client asks the provider whether this session has the vault open.
2. If it hasn't, the client's own prompt asks for the PIN: Mission Control's dialog, or on
   Android the Locked Folder's own unlock screen, biometrics included. The PIN buys a
   single-use grant for exactly these photos, never an unlock, so the Locked Folder stays
   locked and nothing needs locking again.
3. The Locked Folder resolves each reference through Photo's `media.gallery` `resolve`,
   checks it again at the moment of the move, and moves it as it always has (verified copy,
   seal, removal from the library and albums), through `media.gallery`'s server-side
   `original` and `release` (`handover.py`); a move out uses `adopt`. Whether a file was moved
   in is asked through the Engine (`media.vault`'s `sealed`), never of the Locked Folder's code.

A selection is one prompt and one request. A partial move says so. The moved photos leave
the page, every offline copy on the phone, and its image cache. A server without an enabled
Locked Folder shows no such control. See "Moves from a shared interface" in
[the Locked Folder](locked_folder.md).

It binds to read-only routes, `gallery`, `gallery/albums`, `gallery/albums/<id>`,
`gallery/trash`, `gallery/search` and `gallery/map` (`gallery.py`), which shape the same library, albums and recycle bin for
display: the month a photo belongs to, its dimensions and camera as text, whether it is a
favourite. Every action goes to the routes above, unchanged (`albums/favorites/photos`,
`trash/<id>`, `albums/<id>/...`); no route or storage format changed.

## Large libraries

Every list the shared interface and the media picker read - `gallery`, `gallery/search`,
`gallery/albums/<id>`, `gallery/trash` and `media` - takes an optional `limit` (1-500) and
`cursor`, and then answers one page with the cursor of the next in `next` (null at the end).
Without `limit` it answers everything, as it always did, so older clients are unaffected. The
cursor is the last photo's place in a fixed order - newest first, then by id (the recycle bin:
most recently binned first) - not a page number, so a photo added or removed between two pages
never makes another appear twice or go missing. A `limit` or `cursor` that can't be used is a
400. An album keeps its own order - the order photos were added in, or its folder's - like
Photo's own screens: its cursor holds the last photo shown and its position, and a page starts
after that photo, or where it was if it has left the album since.

The map pages differently, because clustering needs every point of an area: `gallery/map?overview=1`
answers only the count and bounds of the located photos, and `gallery/map?bbox=s,w,n,e&zoom=z`
the photos in that area - one by one up to 300, and beyond that one cluster per cell of a grid
about 64 px wide at that zoom, with its count, bounds and newest photo as its cover. Nothing in
the area is left out: the counts add up. `gallery/map` alone still answers every located photo.

Measured on an isolated demo with 50,000 photos (Windows, Python 3.14, the development machine):

| | Time | Size |
| --- | --- | --- |
| `gallery` without `limit` (what older clients read) | 1.9 s | 24 MB |
| `gallery?limit=120`, first or later page | ~115 ms | 59 KB |
| `media?limit=200` (the picker) | ~90 ms | 30 KB |
| `gallery/map` without parameters | 0.44 s | 8.7 MB |
| `gallery/map?bbox=…&zoom=4` (all of Europe, 15,000 located photos) | ~125 ms | 1.9 KB, 6 markers |
| a walk through all 99 pages of 500 | 11 s | 49,500 items, none twice, same order |

Each page sorts the library, which is most of those ~115 ms; Photo's own Android screen, which
reads the whole library at once, did not finish loading it on the emulator within a minute.

## Media picker provider

Photo provides the `media.gallery` capability (`satellite.toml`), so any interface can let a
person choose from the library through the client's media picker without naming Photo (the
`pick` action in [docs/ui-contract.md](../ui-contract.md)):

- `list` is `GET media?kinds=image,video[&limit=N&cursor=C]`: the active library, newest first, with an id, kind,
  title, duration and month - never a path. A photo in the recycle bin is not listed, and
  nothing in the Locked Folder ever is (it never enters this library, and the Locked Folder
  provides no capability). Like every route, it answers signed-in sessions only.
- `thumbnail` is the existing `thumbnails/<id>`.

A pick returns references, `{"provider": "Photo", "capability": "media.gallery", "id", "kind"}`.
`POST albums/<id>/photos` accepts them as `{"items": [...]}`: only references to Photo's own
`media.gallery`, and only to photos the active library has; anything else is refused with 400
and nothing is added. The shared Album page's "Add photos" uses it. Photo's own page and
screens keep their existing "add to album" from a photo.

## Command

```
photo                          summary of the library
photo list [count]             the most recent photos
photo import <directory>       import a directory
photo config                   show Photo's current settings
photo config <key> <value>     change one, e.g. photo config trash_retention_days 14
```

`photo config` reads and writes the same settings, the same `config.toml`, as Mission
Control's Config button on the Photo card. A change is validated, written back to
`config.toml` with its comments kept, and used straight away: none of Photo's settings needs a
restart.

## Phone backup

Photo provides `media.sync` v1 (`backup.py`): a one-way backup of a device's media into the
library. The server side is done (S1 of [the parity audit](../photos-parity-audit.md), which
holds the whole design); the app's side, `device.media-sync`, comes in S2 and S3. The previous
phone sync - a standalone listener with one shared token, and `sync_upload` - is removed (S0).

- **`status`** (`GET ?device=`) -> `{accepts: ["image", "video"], max_bytes, chunk_bytes,
  device: {name, last_seen, received}}`. `max_bytes` is 16 GiB, `chunk_bytes` 8 MiB.
- **`check`** (`POST {device, items: [{sha256, size}]}`, at most 500) -> `{known, wanted}`.
  Known is what is in the library, in the recycle bin, was erased from it, or was moved
  somewhere protected (`media.vault`'s `sealed`); the answer never says which. An item larger
  than `max_bytes` is in neither list.
- **`upload`**: `GET /<sha256>` -> `{offset}`, the bytes held for this file. `POST /<sha256>?offset=&size=&name=&folder=&taken=`
  with an `application/octet-stream` body of at most `chunk_bytes` -> `{offset}`, or at the last
  byte `{status: "imported" | "duplicate", id, offset}`. The bytes go straight to a partial file
  on disk, never whole into memory. A wrong offset answers `409` with the right one; a file whose
  SHA-256 doesn't match answers `422` and starts again at 0; a file the library can't read
  answers `415`. `folder` is the phone's folder, mapped to an album by `source_paths` (or
  `sync_default_path`); `taken` (Unix seconds) dates media whose file has no date of its own.
- **`devices`** (`GET`) -> `{devices: [{name, kind, last_seen, received, current}]}`, newest
  first, for a status page. A device credential gets `403`: it reads nothing.

Partial files live in `backup/partials/<caller>/` under the storage folder, keyed by the
caller's opaque session or device id: at most 4 per caller (a fifth drops the oldest), and
one untouched for 7 days is dropped. `backup/devices.json` keeps each caller's name, when it
was last seen and how many files it sent.

**Erased stays erased.** Erasing from the recycle bin, by hand or past its retention, keeps the
item's id (the first 16 hex digits of its SHA-256, nothing else) in `library.json`'s `erased`,
so a backup never sends it again. Importing a folder on purpose still takes such a file in.

**Authentication.** A phone backs up with a device credential the Engine issues for
`media.sync` (`POST /api/auth/devices`, see "Device credentials" in [API](../api.md)): it reaches
only the routes above, never expires and is revoked with the sessions. A signed-in session may
call them too.

## Albums

The Albums section shows three different kinds of grouping side by side, visually
distinguished but backed by the one album model below - there is no separate "physical album"
or "favorites" system, just a `kind` field on the same shape every album already had.

- **Physical.** One per `source_paths` mapping (see "Configuration" above) - created the moment
  that mapping is saved, even before any photo has landed in it. Membership is never stored:
  it's computed from each photo's own `physical_path` (set once, when a phone's upload is taken
  in, by resolving its phone folder against `source_paths`/`sync_default_path` - see
  `configuration.resolve_physical_path()`; nothing sets it until the new phone sync). The path is the source of
  truth, so nothing here can drift out of sync with it, and there is nothing to add or remove a
  photo from directly (`POST /albums/physical:<id>/...` is rejected - edit the source path
  instead). A photo synced with a phone folder that matches no mapping still gets a physical
  album: `sync_default_path`. A photo imported from a directory has no physical album at all. `GET /albums/physical:unsorted` is a standing catch-all for a physical_path whose
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
its record, or `None` when the exact same content is already stored. Directory import and a
file moved back out of the Locked Folder are built on it, and the new phone sync will be:
everything that enters the library goes through the same storage layout, identifiers,
deduplication and metadata, whichever door it came in through. What kind of file it is, is
decided from its content (see "Supported formats"), never from its name - which is what lets an
upload written aside under a temporary name be taken in at all.

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
