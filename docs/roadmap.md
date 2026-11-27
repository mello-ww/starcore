# Roadmap

The roadmap represents the long-term direction of StarCore, and the current state of what is
already built. Items may change as the project evolves.

`[x]` means implemented **and** covered by the automated tests or checked by hand. `[ ]` means
planned. What was implemented but not verified is under "Not verified yet".

## Current state

At 2026-11-27 (`347d7dd`), on top of the 0.1.0-alpha.1 release and the stable checkpoint
`checkpoint-2026-11-02` (the StarCore design-language redesign). The test runs recorded at
each step until then are in this file's history (`git log -p docs/roadmap.md`).

- **UI contract 1.2** (`starcore.ui/1.2`) is complete and ships with the first release after the
  Alpha; until then it is marked "not released yet" (`docs/ui-contract.md`). It added media
  blocks and the shared viewer, `search` and `map`, `play`, `pick`, `own`, `secure`, `download`
  and `share`, offline pages, the actions row, templates and capabilities; changes 1 to 17 are
  listed there.
- **Every Satellite is on its shared interface on both clients** (Status, File Explorer, Photos,
  the Locked Folder, Music): no Satellite has client code of its own, and the modularity guard's
  exception lists are empty (`docs/remaining-work.md`). Music plays through the shared audio
  host, with gapless playback on Android; Photos' phone backup, the Locked Folder's
  management and "Open with" / "Show in folder" between Satellites are done.
- What is left before release 1 is in `docs/remaining-work.md` and the sections below:
  verification on a physical phone and on Linux, a dependency audit, then the release itself
  (`docs/releasing.md`).

### Not verified yet

- The Python tests skipped on Windows (51 at `347d7dd`, among them: permission denials, symlink cases - among
  them the Locked Folder check that a symlink into the vault stays blocked while locked - and
  FFmpeg video thumbnails): run them on Linux before relying on those behaviours.
- A physical Android phone: biometric unlock and grants, background playback, the
  notification and lock-screen controls, audio focus, Android's handling of a changed
  fingerprint enrollment (unit tests only).
- Real audio output, music and video streaming and uploads over 1 MB through the production
  HTTPS proxy.
- Linux and macOS hosts for Locked Folder encryption; a real power cut, full disk or Windows
  password reset (simulated only).
- iOS, which doesn't exist yet.

### Implemented

- **Design language**: shared tokens (`mission_control/tokens.css`, mirrored in
  `mobile/src/theme/tokens.ts`), five accent presets that apply live on web and Android,
  one shared switch and one shared Settings gear on both, and a personalised Home
  ("Welcome back, <username>").
- **Mission Control**: every page and dialog on the tokens; every Satellite is drawn by the
  shared renderer (Music with its sidebar layout), with a persistent shared player.
- **Android app**: multiple servers, sign-in, per-server biometric app lock, Home, Satellites,
  Console, Config and Settings tabs, swiping between tabs, and every Satellite on the shared
  renderer.
- **Locked Folder**: its own shared interface on both clients (browse, view, move out, setup,
  recovery, PIN, encryption, location); Photos lists it among its folders. Verified moves to
  and from Photos; private media kept out of Photos' imports,
  sync, albums and caches; optional, server-verified biometric unlock on Android. See
  `docs/satellites/locked_folder.md`.
- **Locked Folder encryption at rest** (opt-in, with the `encryption` extra): AES-256-GCM in
  authenticated 1 MiB segments with per-file keys, a random vault key wrapped by a
  DPAPI-protected (Windows) server key and an optional recovery key, an explicit, resumable
  migration that keeps the originals as a backup until the owner deletes it, PIN records and
  biometric devices bound to the vault, and PIN lockouts that survive restarts.

### Known limitations

- The Android app has no light theme (web Music has one).
- Locked Folder encryption is server-side: it protects copies of the vault, backups and (on
  Windows) a stolen disk, not a compromised server. On Linux/macOS the server key is a plain
  0600 file, so a disk holding both the vault and StarCore's data directory needs full-disk
  encryption. File sizes and counts stay visible. See "Encryption at rest" in
  `docs/satellites/locked_folder.md` for the full threat model.
- An unencrypted Locked Folder (the default until the owner turns encryption on) has no PIN
  recovery and no protection against someone who can edit StarCore's files.
- An encrypted Locked Folder without a recovery key is lost for good if the server key is
  lost (reinstall, new machine, Windows password reset by an administrator).
- Unlocks are in memory, so a restart locks every session (deliberately).
- Without Pillow on the server, Locked Folder (like Photos) shows originals as thumbnails.
- The Signal Bus is not implemented yet (`engine/starcore/signals.py` is empty).
- Space Mode does not exist yet. Developer Mode is a visibility preference only (see
  docs/satellites.md).

### Security review (2026-11-02)

Non-destructive review. The two confirmed weaknesses it found have since been fixed:

- **Unbounded JSON request bodies (fixed).** `_read_json_body()` read the whole
  `Content-Length` into memory, including on `/api/auth/login`, which needs no session. It
  now checks the declared size before reading: 64 KB for the sign-in endpoints, 16 MB for
  everything else, `413` above that, and `400` for an invalid `Content-Length`. File
  uploads are streamed and unaffected.
- **No sign-in throttling (fixed).** `/api/auth/login` had no attempt limit. Now, after 5
  failed sign-ins in a row from one client address, that address gets `429` with
  `Retry-After` for 30 seconds, doubling on each further lockout up to 15 minutes; a
  successful sign-in resets it. The record is in memory only. Behind a reverse proxy all
  clients share the proxy's address, and so share one lockout.

Potential risks:

- Before the first administrator is created the API is open by design; this is only safe
  while the server stays on `127.0.0.1`.
- The Android app allows cleartext HTTP for any host (deliberate, for LAN servers), so
  without HTTPS the session token crosses the network in the clear.
- `npm audit` reports 33 advisories in the Android project. Almost all are build-time
  tooling (React Native CLI, Metro, codegen). The one shipped in the app, React Navigation's
  `query-string`/`decode-uri-component` denial of service, is not reachable: the app
  registers no deep links.

Found and fixed while moving the Locked Folder into Photos (each covered by
`engine/tests/test_locked_folder_security.py`):

- Anyone signed in could repoint or delink the Locked Folder without the PIN, then read the
  old vault through File Explorer - and reset a PIN lockout the same way. These settings now
  need the vault unlocked.
- Signing in again for a fresh session reset the per-session PIN limit. An account-wide
  limit now backs it up, and parallel guesses can no longer exceed either.
- A damaged `pin.json` read as "no PIN", letting anyone set a new one. It now keeps the
  vault locked.
- Right after a restart, File Explorer's guard let the vault through until something else
  had touched the Locked Folder. It now creates the runtime itself.
- Renaming or deleting a folder *containing* the vault was not guarded.
- Photos could import the vault (or a folder containing it) into the public library, and a
  photo moved into the vault could come back through phone sync.

Found and fixed while adding encryption (covered by
`engine/tests/test_locked_folder_encryption.py`):

- The account-wide PIN limit was in memory, so a restart reset it. It is now persisted and
  written before each PIN check; damaged or unsaveable counters lock rather than open.
- Deleting or replacing `pin.json` let anyone signed in set a new PIN. For an encrypted vault,
  the PIN record and device list are now bound to the vault key and fail closed. (An
  unencrypted vault still can't defend against someone who can edit StarCore's files.)
- On Windows, a source file left open by an interrupted encryption blocked moving the
  original afterwards; the source is now always closed.

Checked and fine: PBKDF2-SHA256 (260,000 iterations, per-secret salt) and constant-time
comparison for the password and Locked Folder PIN; `HttpOnly; SameSite=Lax` session cookies
(`Secure` over HTTPS); path traversal refused for Mission Control and satellite assets;
Locked Folder unlocks kept in memory only; Android tokens in the Keychain with app backup
disabled; no shell commands built from user input; the engine has no required third-party
Python dependencies (`cryptography` is an optional extra, for Locked Folder encryption).

## Engine

- [x] Bootstrap
- [x] Configuration (TOML, defaults merged on upgrade, edits from Mission Control)
- [x] API (sessions, satellites, commands, configuration, restart and shutdown)
- [x] Authentication (single administrator, sessions per device, revocation)
- [x] HTTPS with a provided certificate
- [ ] Storage (satellites keep their own SQLite and JSON stores today)
- [ ] Signal Bus
- [x] UI contract 1.0: validated `ui.json`, revisions and ETags, the capability catalog, metadata-only rediscovery (`docs/ui-contract.md`)
- [x] UI contract 1.1: `chart`, `table`, `choice`, `status`, `code`, the `dashboard` template, page state and sources, Home widgets, dates in formats
- [x] UI contract 1.2 (ships with release 1): media blocks and the shared viewer, `search` and `map`, `play`, `pick`, `own`, `secure`, `download` and `share`, offline pages, `preview`
- [x] UI contract next: templates, discovered sections
- [x] Retire every Satellite-specific interface (`docs/remaining-work.md`)

## Mission Control

- [x] Dashboard (Home)
- [x] Authentication
- [x] StarCore design language and accent presets
- [x] Satellite pages, configuration dialogs and lifecycle controls
- [x] Developer Mode
- [x] Shared renderer for UI contract documents, Rediscover button, folder picker through `files.browse`
- [ ] Space Mode

## Android app

- [x] Multiple servers, sign-in and per-server biometric app lock
- [x] StarCore design language with live accent
- [x] Native Music, declarative screens for every other satellite
- [x] Shared renderer for UI contract documents; icons from `icon_name`
- [ ] Rediscover and cache controls in the app
- [x] Move Status onto shared blocks, at parity - UI contract 1.1 (`docs/satellites/status.md`, "Status's migration")
- [x] Retire Status's previous page and screen
- [x] Specify `media.audio` and `audio.library` from Music's player (`docs/media-audio.md`)
- [x] Audio contract groundwork: `audio.library` v1 in the vocabulary, provided by Music; `media.audio` reserved
- [x] Audio: the Android AudioHost (`mobile/src/media/`), playing from the catalog's `audio.library` provider
- [x] Audio: `audio.session` v1 in the shared vocabulary (`queue` required, the rest optional)
- [x] Audio: the lock-screen pause on Android (the 0:00 was the end of the queue; the app now follows a pause or resume made outside it)
- [x] Audio: the web AudioHost (`mission_control/media/`), started by the shell, playing from the catalog's `audio.library` provider
- [x] Audio: any Satellite can play through both clients with the UI contract's `play` action (1.2)
- [x] Remove `mobile/src/satellites/builtins.tsx` once Music's declarative interface replaces its native screens (A10)
- [x] Move Photos, the Locked Folder and Music onto shared blocks and capabilities, at parity (`docs/ui-contract.md`, "Migration")
    - [x] Photos opens in its shared interface by default on both clients (M1-M6 of `docs/photos-parity-audit.md`)
    - [x] Photos' shared interface after the owner's review: whole photo in the viewer, full width, Favorites and the Locked Folder among the folders, tile hearts, download and share, web swipe, Library grouping (M7-M14)
    - [x] Retire Photo's own page and screens once the shared interface is validated
    - [x] Move File Explorer onto its `ui.json`, giving Android a file browser (`docs/file-explorer-migration.md`)
        - [x] F1: read-only browsing, as a preview (Android opens it; the web keeps its own page)
        - [x] F2-F5: list paging, the file page (download, share, open), management, upload
        - [x] F6-F7: shared by default, then retire its own page
    - [x] The Locked Folder through `media.vault`, its only interface on both clients (R3 of `docs/remaining-work.md`)
    - [x] Music on `ui.json` (R4 of `docs/remaining-work.md`)
- [ ] Light theme (after the stable release)
- [x] Icons instead of text glyphs for the remaining Music controls
- [ ] Audio playback validated on a real device (release 1)

## Native Satellites

- [x] Status
    - [x] Real CPU, memory, swap, storage, disk I/O, network, system and service readings on Linux
          and Windows, standard library only; unavailable readings say why
    - [x] Background sampler with a bounded history (1h, 24h, 7d, 30d) and downsampling
    - [x] Warnings and an overall health state
    - [x] Mission Control dashboard (Overview, Hardware, Network, Services, History, Diagnostics)
          and a Home summary that adds no polling
    - [x] Native Android screens and a Home summary
    - [x] CLI: `status`, `status hardware`, `status network`, `status services`, `status history`
    - [ ] GPU, fan, battery and power readings
    - [ ] CPU temperature on Windows (needs vendor tools or administrator WMI access)
    - [ ] Monitoring other machines (the Ollama/Open WebUI server, Wings nodes) - the snapshot and
          history formats already carry a node name
    - [ ] Verified on a real Linux host (Linux readings are tested against a fake /proc and /sys)
- [x] Files (File Explorer)
- [x] Locked Folder (PIN, lockout, isolation from File Explorer)
    - [x] Move Locked Folder into Photos (a Photos tab on web and Android)
    - [x] Biometric unlock on Android, verified by the server
    - [x] Encryption at rest (opt-in), with a recovery key and backups kept until deleted
    - [x] PIN lockouts that survive restarts
- [x] Photos
    - [x] Library indexing, thumbnails, albums, favorites, map, recycle bin
    - [x] Source-path mapping into physical albums
    - [x] Phone sync: the old one is removed (S0), its new form is S1 to S5 of `remaining-work.md` (only the owner's phone, S4, is left)
- [x] Music
    - [x] SQLite catalog with migrations, stable track identities, incremental and scheduled scans
    - [x] FLAC, MP3, WAV, M4A (AAC/ALAC), Ogg Vorbis and Opus metadata, credits, ReplayGain, quality
    - [x] Authenticated range streaming, optional FFmpeg transcoding to a bounded cache
    - [x] Playlists (smart, M3U import/export), likes, pins, history, stats, Wrapped
    - [x] Local, explainable discovery: Home, Daily Mixes, radio, moods
    - [x] Lyrics from sidecar LRC/TXT and tags (synced, word timing, translations)
    - [x] StarCore Connect devices, remote commands and handoff over long-poll
    - [ ] Playlist and import integration with other sources
    - [ ] Metadata enrichment providers (MusicBrainz, Cover Art Archive), opt-in and rate limited
    - [ ] Optional external lyric lookup that respects provider terms
    - [ ] Scrobbling Links (Last.fm, ListenBrainz) fed from play history
    - [ ] OpenSubsonic API compatibility Link, and the Riff Link built on it
    - [ ] Collaborative playlists, once StarCore has more than one account and a sharing model
    - [ ] Audio analysis (BPM, key, loudness) for discovery and automatic normalisation

## Link Satellites

- [ ] Docker (loads and reports status; not otherwise tested)
- [ ] Home Assistant
- [ ] Jellyfin
- [ ] Links
- [ ] Wings
- [ ] AI integration with Open WebUI

## Security

- [x] Request body size limit and sign-in throttling (see the review above)
- [x] Hashed session tokens at rest
- [x] The auth store locked against concurrent writes (requests run on threads), and a "last
  used" kept for device credentials, so a stale one can be told apart
  (`photos-parity-audit.md`, "Security review of S1 to S4")
- [ ] Periodic security audits, including dependency audits
- [x] Locked Folder encryption at rest (server-side; see its threat model)
- [ ] End-to-end encryption for the Locked Folder (keys never on the server)
