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

## Metadata

For every photo the index records the identifier, the original filename, the stored path,
the file size, width, height, format and the import timestamp. `captured_at` is filled from
the EXIF `DateTimeOriginal` field when the file carries one; photos without EXIF simply have
no capture date. Nothing is guessed or invented.

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
POST /api/satellites/photo/scan               preview a directory  {"source": "..."}
POST /api/satellites/photo/import             import a directory   {"source": "..."}
```

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

## Command

```
photo                     summary of the library
photo list [count]        the most recent photos
photo import <directory>  import a directory
```

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
