# Music

The Music Satellite is StarCore's local music library.

It indexes audio files where they already are, keeps its own metadata index and serves its
own Mission Control page. As with Photo, the Core knows nothing about music: everything
below is contributed through the Satellite extension points.

## Storage

Music is **not** copied into StarCore. A collection is usually already organised on disk and
can be very large, so the Satellite indexes files in place and never moves, rewrites or
deletes them. Only the index and extracted cover art live in the Satellite's storage:

```
satellites/native/music/
    data/
        library.json         the index
        artwork/<album>.jpg  cover art extracted from the files, safe to delete
```

A track's identifier is a digest of its size together with the first and last 256 KB of the
file. Hashing whole albums of lossless audio on every scan would make the library unusable,
and those bytes differ between any two recordings. The identifier makes the same file found
in two places a single entry, and lets a file that moved keep its identity.

## Configuration

`satellites/native/music/config.toml`:

```toml
enabled = true
storage = "data"     # relative paths are resolved inside the satellite
library = "~/Music"  # the directory 'music scan' indexes by default
```

`library` is only the default target. A scan can be pointed at any directory, and the index
is the union of everything scanned that still exists on disk.

## Supported formats

MP3, FLAC, WAV and MP4/M4A. Tags, duration and embedded cover art are read straight from the
container headers by the Satellite's own `audio.py`, using only the standard library:

- **FLAC** - STREAMINFO for duration, VORBIS_COMMENT for tags, PICTURE for art
- **MP3** - ID3v2.3/2.4 frames with an ID3v1 fallback, Xing/Info or bitrate for duration, APIC for art
- **WAV** - the `fmt `/`data` chunks for duration, an optional LIST/INFO chunk for tags
- **MP4/M4A** - `mvhd` for duration, `ilst` for tags, `covr` for art

Metadata is never required. A file whose tags cannot be read is still indexed, with its
filename as the title and empty fields elsewhere; a file whose container cannot be
understood is reported in the scan result and skipped.

## Scanning

```
music scan [directory]
```

A scan walks the directory, and for each supported file:

- skips it when the index already has that path with the same size and modification time
- otherwise fingerprints it, reads its tags and adds or updates the entry
- counts it as a duplicate when the same content is already indexed somewhere else that still exists
- follows a move when the content is known but its old path is gone

Afterwards, entries whose files have disappeared are removed. The result reports found,
added, updated, unchanged, duplicates, removed and failed counts.

## API

```
GET  /api/satellites/music/library         library summary
GET  /api/satellites/music/tracks          every track
GET  /api/satellites/music/tracks/<id>     one track's metadata
GET  /api/satellites/music/albums          every album
GET  /api/satellites/music/albums/<id>     one album and its tracks
GET  /api/satellites/music/artists         every artist
GET  /api/satellites/music/artwork/<album> cover art, extracted on first request
GET  /api/satellites/music/stream/<track>  the audio file, with Range support
POST /api/satellites/music/scan            index a directory  {"source": "..."} (optional)
```

Albums and artists are grouped from the index rather than stored separately, so there is one
source of truth. Tracks and albums are only ever addressed by identifier: an identifier the
index does not know is a 404, and no request can name a path, so nothing outside the indexed
files can be reached. Everything is read-only except `scan`.

## Mission Control

The Music page browses the library by album, artist or track, with a search box that filters
whatever is on screen. Selecting an album opens it with its cover and track list, and
selecting a track plays it in a compact player built on the browser's own `<audio>` element -
the file is streamed from the `stream` route, which answers Range requests so seeking works
without downloading the whole track.

Playback state lives entirely in the page. There is no server-side player, no queue shared
between devices and no transcoding: what the browser can decode is what plays.

## Command

```
music                     summary of the library
music scan [directory]    index a directory
music list [count]        the most recent tracks
music albums [count]      albums with their track counts
```
