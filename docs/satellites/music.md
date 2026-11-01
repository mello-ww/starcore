# Music

The Music Satellite is StarCore's self-hosted music service: a library indexed in place,
streaming with optional transcoding, playlists, likes, history, lyrics, local discovery and
StarCore Connect for moving playback between devices. As with Photo, the Core knows nothing
about music: everything below is contributed through the Satellite extension points, and
Mission Control and the mobile app are clients of the same API.

## Storage

Music is **not** copied into StarCore. A collection is usually already organised on disk and
can be very large, so the Satellite indexes files in place and never moves, rewrites or
deletes them. Only its own database and caches live in the Satellite's storage:

```
satellites/native/music/
    data/
        music.db             catalog and listener data (SQLite, WAL)
        library.json         the pre-database index, imported once and then left alone
        artwork/<album>.jpg  cover art extracted from the files, safe to delete
        artwork/sized/       resized covers (only when Pillow is installed), safe to delete
        covers/              playlist cover images uploaded by listeners
        cache/transcodes/    transcoded copies, bounded by transcode_cache_mb, safe to delete
        cache/exports/       recent M3U exports, safe to delete
```

### Database and migrations

`db.py` holds numbered migrations; `PRAGMA user_version` records how far a database has been
upgraded and each migration runs once, inside a transaction. The catalog (tracks, artists per
track, a full-text index, scans, duplicates) and listener data (favorites, pins, playlists,
plays, preferences, recent searches, playback state, devices, lyric offsets) share one file so
a rescan can never orphan a playlist. A database that fails SQLite's integrity check at start
is moved aside as `music.db.damaged-<timestamp>` (never deleted) and a fresh one is started.

The first time the database opens next to an older `library.json`, every track in it is
imported with its identifier unchanged, so links into the old index keep working.

### Track identity

A track's identifier is first derived from its size together with the first and last 256 KB
of the file; hashing whole albums of lossless audio on every scan would make large libraries
unusable. After that the identifier is **stable**:

- retagging a file (same path, new bytes) keeps its identifier,
- moving a file (new path, same bytes) keeps its identifier,
- a file that disappears is flagged `missing` and hidden, not forgotten; when it comes back
  it is the same track again, with its likes, plays and playlist entries intact.

Byte-identical copies in two places are indexed once; the extra paths are recorded as
duplicates. Likely duplicates across releases (same normalised title and artist, similar
length, different albums) are reported by `GET duplicates`, best quality first.

## Configuration

`satellites/native/music/config.toml` (new keys are added from `config.default.toml`
automatically - see `docs/deployment.md`, "Keeping configuration up to date"):

```toml
enabled = true
storage = "data"               # relative paths are resolved inside the satellite
library = "~/Music"            # the main music folder
sources = []                   # more folders scanned alongside it
exclude = []                   # glob patterns never indexed, e.g. ["*/Podcasts/*"]
min_duration = 0               # skip clips shorter than this many seconds
missing_metadata = "filename"  # or "folders": Artist/Album/NN Title for untagged files
scan_interval = 0              # minutes between scheduled rescans, 0 for none
ffmpeg = "ffmpeg"              # optional transcoder: on PATH, or an absolute path
transcode_workers = 2
transcode_cache_mb = 2048
```

All of these are editable through the generic Config modal and Music's own settings view;
`library` keeps its "Browse…" button. `sources` and `exclude` accept a JSON list, or a string
separated by `;` from the generic modal. Nothing here waits on a restart.

Per-listener preferences (theme, accent, density, streaming and cellular quality, transcode
format, ReplayGain mode, normalisation, crossfade, gapless, equaliser, bass boost, speed,
pitch, lyric offset, history and discovery switches, queue end behaviour, download network
and quality, offline cache size, visualiser) live in the database, per account, behind
`GET/POST preferences`, and are validated server-side (`users.py`).

## Supported formats

MP3, FLAC, WAV, MP4/M4A (AAC and ALAC), Ogg Vorbis and Opus. Tags, technical details and
embedded cover art are read straight from the container headers by `audio.py` and `ogg.py`,
using only the standard library:

- **FLAC** - STREAMINFO (rate, depth, channels, length), VORBIS_COMMENT, PICTURE
- **MP3** - ID3v2.3/2.4 text frames, TXXX (MusicBrainz, ReplayGain), USLT lyrics, APIC art,
  ID3v1 fallback, Xing/Info or bitrate for length
- **WAV** - `fmt `/`data` for length and format, LIST/INFO tags
- **MP4/M4A** - `mvhd` length, `stsd` sample entry (AAC or ALAC, depth, rate), `ilst` tags
  including freeform `----` atoms, `covr` art
- **Ogg Vorbis / Opus** - identification header, comment header, `METADATA_BLOCK_PICTURE`,
  the last granule position for length (minus Opus pre-skip)

Read when present: title, artist(s), album, album artist, track and disc numbers and totals,
date/year, genre(s), composer, producer, label, copyright, ISRC, compilation flag, comment,
lyrics, MusicBrainz track/album/artist/release-group IDs, ReplayGain track/album gain and peak,
codec, sample rate, bit depth, channels and bitrate. Every value is untrusted input: readers
are bounded and isolated so a malformed block only costs the field it carries. A file whose
container cannot be understood is reported in the scan result and skipped.

Cover art comes from the embedded picture first, then a `cover`/`folder`/`front`/`album`
image beside the files. Lyrics come from a sidecar `.lrc`/`.txt` with the same name (or
`Name.<language>.lrc` for more languages), then embedded tags.

### Grouping

Multiple artists come from multi-value tags and from `feat.`/`ft.`/`featuring`, `;` and ` / `
separators (never `&` or `,`, which too many real names contain), plus `(feat. X)` in titles.
An album groups under its album artist, or "Various Artists" for a compilation without one,
or the primary artist. Releases are typed single, EP, album or compilation from their track
count and length. Lossless and Hi-Res badges come from the stream itself (codec, bit depth,
sample rate), never from a file extension: Hi-Res means lossless at more than 16-bit/48 kHz.

## Scanning

```
music scan [directory]
POST scan {"source": "...", "background": true}
```

Without a `source`, every configured folder (`library` plus `sources`) is scanned. A scan walks
each folder (hidden folders, symlinks and Music's own storage are skipped) and for each
supported file:

- skips it when the index already has that path with the same size and modification time
- otherwise reads its tags and updates the entry, keeping its identifier
- records a duplicate when the same content is already indexed somewhere else that still exists
- follows a move when the content is known but its old path is gone

Afterwards, entries whose files have disappeared are flagged missing. The result reports
found, added, updated, moved, unchanged, restored, duplicates, skipped, removed and failed
counts. `background: true` returns at once; `GET scan` reports progress, the last result and
any error, and `POST scan {"cancel": true}` stops a running scan. With `scan_interval` set,
`satellite.py` runs the same scan on a timer while satellite services are enabled.

## Streaming and audio quality

`GET stream/<track>` serves the original file through the Core's file sender, which never
holds a file in memory and answers `Range` requests with 206 (and 416 with `Content-Range:
bytes */<size>` for a range that starts beyond the end). Only identifiers the index knows ever
become a path, so no request can name a file.

`?quality=high|normal|low&format=opus|aac|mp3` asks for a transcode. `GET playback/<track>`
says beforehand exactly what will be delivered (`plan.delivery` is `original` or
`transcode`, with format, bitrate, lossless flag and a `reason` when the original is sent
instead), plus the ReplayGain adjustment for the listener's mode, capped by the peak so a
track is never boosted past full scale. A transcode is never upsampled from a lower-bitrate
original and is never applied silently: lossless only stops being lossless when a listener
picks a lossy quality.

Transcoding needs FFmpeg. It runs with an argument list (no shell), a `file`-only protocol
whitelist, only on paths from the index, at most `transcode_workers` at once, and writes into
`cache/transcodes/` before being served like any other file, so seeking works on transcodes
too. The cache is trimmed oldest-first to `transcode_cache_mb`. Without FFmpeg every request
gets the original and the plan says why.

Playback effects run on the device that plays: see "Web and Android audio" below.

## Listener data

All of it is per account (the session's username; before any account exists, the Core is
open by design and everything belongs to one local listener). Nothing is shared between
accounts, and there is no route that reads another account's data.

- **Favorites** - liked tracks and albums, followed artists (`favorites` kind `artist`).
- **Pins** - up to 12 pinned items for the top of Your Library.
- **Playlists** - create, rename, describe, folder, private/public flag, cover (an album's art
  or an uploaded PNG/JPEG checked by its bytes), add with duplicate warnings, remove, move,
  full reorder, delete, M3U/M3U8 export (paths relative to the library, never absolute) and
  import, and import of plain `{title, artist, album, isrc}` lists matched only against this
  library. Smart playlists are rule-based (title, artist, album, genre, composer, label,
  format, folder, year, duration, bitrate, sample rate, bit depth, lossless, added, plays,
  last played, liked) and compiled to SQL from a whitelist with bound values. Collaborative
  playlists are not offered: StarCore has one account today and no sharing model to build
  them on safely.
- **History** - a play counts once half the track or four minutes has been heard; shorter
  listens are kept as skips (used to keep skipped songs out of mixes). History can be turned
  off per account and cleared.
- **Stats and Wrapped** - top tracks, artists, albums and genres, minutes, plays by hour and
  day; Wrapped adds listening days, the longest streak, the busiest day, the peak hour and
  artists played for the first time that year.
- **Recent searches**, **lyric offsets** and **playback state** (queue, position, shuffle,
  repeat, volume, speed) per device.

## Discovery

`discovery.py` builds Home, mixes and radio from this library and this listener's own plays,
likes and follows only. It is deterministic (the same listener gets the same mixes all day),
every suggestion is a track that exists here, and every track carries the plain reason it
was picked. Nothing is sent to any service.

- Home: a greeting, Continue listening (recent albums/playlists/artists), Recently played,
  Daily Mixes, On Repeat, Recently Rediscovered, Forgotten Favorites, Favorite Artists Mix,
  top albums and artists, Recently added, Recommended (rarely played tracks by top artists or
  in top genres), Liked songs, Genre mixes and Moods. A new listener gets Recently added,
  random albums and genre mixes until there is history to work from.
- Daily Mixes are seeded by the most-played artists (or largest genres), widened to artists
  that share genres or credits, weighted by plays and likes, with skips pushed down and the
  same artist kept from playing twice in a row.
- Radio from a track, artist, album or genre uses the same scoring around its seed.
- Moods group genre tags into Calm, Energy, Groove and Focus and say so; there is no audio
  analysis.
- Wrapped is computed on request for any year.

Discovery can be switched off per account (`discovery_enabled`). A future Ollama-based layer
can sit beside this one; nothing here depends on it.

## StarCore Connect

`connect.py` lets one listener's devices see each other and hand playback over, like Spotify
Connect, using nothing but the HTTP server StarCore already runs:

- `POST connect/register` names a device (`device_id` is chosen by the client, 8-64 letters,
  digits, `-` or `_`) and binds it to the account and session that registered it.
- `POST connect/state` publishes what a device is playing; `GET connect/devices` lists the
  account's devices, which are online (seen in the last 90 s) and which is active.
- `GET connect/events?device=&since=&timeout=` is a long-poll (up to 30 s) delivering state
  changes, device list changes and commands addressed to that device.
- `POST connect/command` sends play, pause, toggle, next, previous, seek, volume, set_queue,
  add_queue, play_next, shuffle, repeat or stop to another of the same account's devices.
- `POST connect/transfer` moves playback: the target receives `transfer_in` with the queue,
  index, shuffle order, repeat mode and a position advanced by the time since the last state,
  and the previous device is told to pause.

A device and its commands are confined to the account that registered it; another account
naming the same device id gets "unknown device". The server only relays intent: audio is
always streamed by the device that plays it. Browsers may refuse to start audio that no
click started, so Mission Control asks for a tap when a transfer lands while the tab has had
no interaction; Android only listens for Connect events while the app is in the foreground.

## API

All routes are under `/api/satellites/music/`, need a session once StarCore has an account
(`Authorization: Bearer` or the session cookie, enforced by the Core), and answer JSON unless
they serve a file.

```
GET  library                      summary, totals, formats, schema version, transcoding availability
GET  tracks                       ?sort=title|artist|album|added|released|duration|quality|plays|random
                                  &order=asc|desc&limit=&offset=&genre=&quality=hires|lossless|lossy&album=&artist=
GET  tracks/<id>                  one track with credits, technical details, liked flag and play count
POST tracks/hide                  {"ids": [...], "hidden": true}  hide or show tracks library-wide
GET  albums                       ?sort=&order=&type=album|single|ep|compilation&genre=&limit=&offset=
GET  albums/<id>                  the album, its tracks, credits, genres and more by the artist
GET  artists                      album artists, ?featured=1 for everyone credited
GET  artists/<id>                 albums, singles and EPs, appears on, top tracks, genres, similar artists
GET  genres
GET  folders                      configured and indexed sources
GET  folders/<n>/<path>           one folder level from the index (never the disk)
GET  duplicates                   identical copies and likely duplicates
GET  search?q=&type=&genre=&quality=&limit=   tracks, albums, artists, playlists, genres, top result
GET  search/suggest?q=
GET  search/recent                POST {"query": ...} remembers one, {"clear": true} forgets all
GET  artwork/<album>?size=        cover art (resized when Pillow is installed)
GET  lyrics/<track>?language=     synced lines (with words and translations) or plain text
POST lyrics/<track>               {"offset": ms}
GET  scan                         progress and last result;  POST scan {"source", "background", "cancel"}

GET  favorites                    POST {"kind": "track|album|artist|playlist", "ids": [...], "liked": bool}
GET  pins                         POST {"kind", "id", "pinned"}
GET  playlists                    POST {"name", "description", "folder", "visibility", "rules", "tracks"}
GET  playlists/<id>               POST {"name"|"description"|"folder"|"visibility"|"rules"|"cover"}
POST playlists/<id>/add           {"tracks": [...], "allow_duplicates", "position"}
POST playlists/<id>/remove        {"entries": [...]}
POST playlists/<id>/move          {"entry", "to"}
POST playlists/<id>/reorder       {"entries": [...]}
POST playlists/<id>/cover         raw PNG/JPEG body, or {"album": id}
POST playlists/<id>/delete
GET  playlists/<id>/export        M3U8 download
POST playlists/import             {"name", "content"} for M3U, or {"name", "entries": [...]}
POST playlists/preview            {"rules"}
GET  covers/<id>                  an uploaded playlist cover
GET  history?limit=               POST {"track_id", "seconds", "device", "context"};  POST history/clear
GET  stats?days=                  GET wrapped?year=
GET  preferences                  POST {key: value, ...}
GET  home?hour=                   GET recommendations
GET  mixes                        GET mixes/<id>
GET  radio/<track|artist|album|genre>/<id>
GET  moods                        GET moods/<id>

GET  stream/<track>?quality=&format=
GET  playback/<track>?quality=&format=
GET  queue?device=&expand=1       POST {"device", "state"}
GET  connect/devices | events | cursor | active
POST connect/register | state | command | transfer | forget

GET  mobile                       the generic declarative screen
GET  configuration                POST {"key", "value"}
```

## Mission Control

The Music page is a full player inside the existing Satellite page contract (`page.js` and
ES modules beside it, `page.css`): Home, Search, Your Library (playlists, liked songs, albums,
artists, recently played, folders, genres), album, artist, playlist, mix, radio, mood,
stats/Wrapped and settings views, a persistent bottom player and a full-screen player with
lyrics, queue, devices and track details. The audio engine and the bottom bar live outside the
page's container, so playback continues while browsing other Mission Control pages. Large
album, artist and song lists are drawn in chunks as they scroll. See
`satellites/native/music/mission_control/`.

## Mobile

StarCore Mobile opens Music on its own screens (Home, Search, Library, album, artist,
playlist, full-screen player with queue, lyrics, info and devices, equaliser, downloads,
settings) with a mini-player above the tab bar. Playback uses `react-native-video` (already a
dependency), which runs ExoPlayer in a media session service for background playback, the
notification and lock-screen controls, audio focus and becoming-noisy handling; no new
dependency was added. A small app-local native module (`mobile/android/.../music/`) adds the
equaliser, bass boost, pitch and speed on that player's audio session, and offline downloads
into app-private storage per server. Music lives under the signed-in server's `AuthProvider`,
so queues and downloads are per server and the biometric lock hides it like everything else.
The system notification offers play/pause and seek buttons, not next/previous (a limit of the
library's service). See `mobile/README.md` and `mobile/src/music/`.

## Status

Verified here: the backend (automated tests and a 50,000-track benchmark), the Mission Control
page in Chromium against a real engine (playing generated FLAC files, navigating without
interrupting playback, queue restore after reload, synced lyrics with click to seek, history,
mixes, mobile-width layout, chunked lists), the mobile JS (Jest, TypeScript, ESLint, Metro
release bundle) and the Android debug build.

Not verified: playback, notification, lock screen, Bluetooth, audio focus, equaliser and
downloads on a physical Android device; Connect handoff between two real devices; FFmpeg
transcoding against a real FFmpeg (the command line is tested, not run); web crossfade,
equaliser and visualiser by ear or by eye; playback error recovery in the browser.

Not implemented: metadata enrichment from external providers, external lyric lookup,
scrobbling, OpenSubsonic, collaborative playlists, Android background Connect control
(Connect listens only while the app is in the foreground), gapless playback on Android,
crossfade on Android.

## Command

```
music                     summary of the library
music scan [directory]    index a directory, or every configured folder
music list [count]        the most recent tracks
music albums [count]      albums with their track counts
```

## Security

- Every route sits behind the Core's session check; there is no unauthenticated media URL.
- Files are only reached through identifiers the index holds; folder browsing reads the index,
  not the disk, and rejects `..`.
- API payloads never contain absolute paths; M3U exports use library-relative paths.
- Metadata, filenames, playlists files and lyric files are untrusted: parsers are bounded,
  lyric and import sizes are capped, smart playlist rules are whitelisted and bound.
- FFmpeg never sees a shell or a URL.
- Uploaded covers must be PNG or JPEG by their bytes, at most 4 MB.
- No external service is contacted. Metadata enrichment, scrobbling and lyric lookups are
  deferred extension points (see `docs/roadmap.md`) and will be opt-in.
- A scan may be pointed at any directory by an authenticated administrator (as before); only
  audio files are ever indexed or served from it.

## Future Links

These are extension points, never runtime dependencies: a Riff Link (the Riff client talking
to this API), OpenSubsonic compatibility (an API translation layer over the same routes),
external OpenSubsonic servers as sources, Last.fm and ListenBrainz scrobbling (from `plays`),
MusicBrainz enrichment (the `enrichment` table is the cache it will use), Discord Rich
Presence (from Connect state), external discovery, and a desktop companion (a Connect device).
Public playlist imports already work through `playlists/import` entries matched against the
library. No unauthorised downloads, DRM circumvention or Spotify account emulation.
