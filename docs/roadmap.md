# Roadmap

The roadmap represents the long-term direction of StarCore, and the current state of what is
already built. Items may change as the project evolves.

`[x]` means implemented **and** covered by the automated tests or the checks listed under
"Current state". `[ ]` means planned. Anything implemented but not verified says so.

## Current state

Stable checkpoint: tag `checkpoint-2026-11-02` (see `git show checkpoint-2026-11-02` for the
exact commit). It contains the StarCore design-language redesign of Mission Control and the
Android app, on top of the Music, Photo and Locked Folder satellites.

### Verified at the checkpoint

Run on Windows 11 with Python 3.13, Node 24 and JDK 17. Python tests use temporary
directories only; the web checks ran against a throwaway demo server with temporary Music,
Photo and Locked Folder storage, never a real library.

| Check | Result |
| --- | --- |
| Python engine and satellite tests (`python -m unittest discover -s tests -t .` in `engine/`) | 679 tests: 674 passed, 5 skipped, 0 failed |
| Mission Control scripts (`node --check` on every tracked `.js` outside `mobile/`) | 35 files, all parse |
| Mission Control API smoke test (sign-in, 401 when signed out, every satellite page, path traversal refused, Locked Folder session checks) | 35 / 35 |
| Mission Control visual checks (Home, Satellites, Configuration, Music, Photo, Locked Folder, File Explorer, Status; 1440, 1000 and 390 px wide; dark and light Music; accent changes) | Checked by screenshot |
| Android Jest | 30 suites, 288 tests passed |
| Android TypeScript (`tsc --noEmit`) and ESLint (`src`, `__tests__`) | Clean |
| Android Metro release bundle | Builds |
| Android `assembleDebug` (JDK 17) | Builds |
| Android emulator (API 37, 1080×2400): server list, sign-in, Home, Satellites, Music, Music Settings, Photos, live accent change | Checked by screenshot |

The 5 skipped Python tests need things this Windows machine does not provide: two
permission-denial cases, two symlink cases (one of them is the Locked Folder check that a
symlink into the vault stays blocked while locked) and one FFmpeg video-thumbnail case. They
should be run on Linux before relying on those behaviours.

Not verified: real audio output (the demo library is empty and no speakers were checked),
any physical Android device, iOS, Linux hosts, and HTTPS with a real certificate.

### Photos grid and Locked Folder in Photos (after the checkpoint)

Verified on the same machine against a demo server whose every satellite configuration was
redirected to temporary folders (generated test photos, a temporary vault, a test PIN):

| Check | Result |
| --- | --- |
| Python tests | 727 tests: 722 passed, 5 skipped (the same 5 as above), 0 failed |
| Mission Control scripts | 36 files, all parse; API smoke test 35 / 35 |
| Photos gallery columns (1440 / 1000 / 390 / 300 px wide) | 7 / 5 / 3 / 2, no horizontal overflow |
| Web Locked Folder in a browser: wrong PIN, unlock, move in from the viewer, relock after the move, on leaving the tab, on reload and on navigating away, move out | All as expected |
| Android Jest / TypeScript / ESLint / Metro release bundle | 32 suites, 312 tests passed; clean; clean; builds |
| Android `assembleDebug` (JDK 17, with the new native privacy module) | Builds |
| Android emulator: Locked section hidden from Home and Satellites lists, PIN unlock, relock on background, biometric enrollment and unlock with a simulated fingerprint, move out and move in, FLAG_SECURE (screen capture comes out blank) | All as expected |

Not verified: biometric unlock on a physical phone, and Android's handling of a changed
fingerprint enrollment (covered by unit tests only).

### Locked Folder encryption, persistent lockouts and recovery (after the checkpoint)

Same machine, same isolated demo server (temporary photos, vault, keys and test PIN; the
encryption extra installed in `engine/.venv`):

| Check | Result |
| --- | --- |
| Python tests | 776 tests: 771 passed, 5 skipped (the same 5), 0 failed - 49 of them new in `test_locked_folder_encryption.py` |
| Mission Control scripts | 35 tracked files, all parse; API smoke test 35 / 35 |
| Web Locked Folder in a browser: encrypt with a recovery key (key shown once, confirmation required), photos decrypting in the grid, an upload stored encrypted, a move in from Photos, deleting the backup with the PIN, relock on reload, a wrong and a right recovery key, the old PIN refused and the new one accepted, the "needs attention" state at 390 px | All as expected; no plaintext left in the vault folder |
| Android Jest / TypeScript / ESLint | 32 suites, 315 tests passed; clean; clean |
| Android `assembleDebug` (JDK 17) | Builds |

Not verified: the emulator was not re-run (only TypeScript changed on Android - the "needs
attention" state and an "encrypted" note); a physical phone;
Linux and macOS hosts; a real power cut or full disk (both simulated); a real Windows password
reset.

### Implemented

- **Design language**: shared tokens (`mission_control/tokens.css`, mirrored in
  `mobile/src/theme/tokens.ts`), five accent presets that apply live on web and Android,
  one shared switch and one shared Settings gear on both, and a personalised Home
  ("Welcome back, <username>").
- **Mission Control**: every page and dialog on the tokens; Music runs as a full-height app
  with a fixed sidebar, a persistent mini-player and its own scrolling content, falling back
  to page scrolling on phone widths.
- **Android app**: multiple servers, sign-in, per-server biometric app lock, Home, Satellites,
  Console, Config and Settings tabs, and native Music and Photos screens.
- **Locked Folder in Photos**: a tab of Photos on web and Android instead of a satellite of
  its own; verified moves to and from Photos; private media kept out of Photos' imports,
  sync, albums and caches; optional, server-verified biometric unlock on Android. See
  `docs/satellites/locked_folder.md`.
- **Locked Folder encryption at rest** (opt-in, with the `encryption` extra): AES-256-GCM in
  authenticated 1 MiB segments with per-file keys, a random vault key wrapped by a
  DPAPI-protected (Windows) server key and an optional recovery key, an explicit, resumable
  migration that keeps the originals as a backup until the owner deletes it, PIN records and
  biometric devices bound to the vault, and PIN lockouts that survive restarts.

### Known limitations

- The Android app has no light theme (web Music has one).
- Android Music still draws some controls (♥/♡, shuffle, repeat, transport) as text glyphs,
  not icons; some phones render them as emoji.
- The Android Config tab keeps a sliders icon, so it does not look identical to Settings.
- Mission Control still carries hidden legacy markup and styles from the previous design
  (the starfield and asteroid belt in `index.html`, their rules in `style.css`).
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
- The Locked Folder location, encryption, the recovery key and PIN changes are managed from
  Mission Control only; the Android app can create the PIN and shows problems, but doesn't
  pick the folder or recover.
- The Signal Bus is not implemented yet (`engine/starcore/signals.py` is empty).
- Space Mode does not exist yet. Developer Mode is a visibility preference only (see
  docs/satellites.md); File Explorer has nothing behind it yet.

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

- Session tokens are stored unhashed in the auth store on disk; anyone who can read that
  file can use live sessions.
- Before the first administrator is created the API is open by design; this is only safe
  while the server stays on `127.0.0.1`.
- Unexpected server errors return the exception text (`internal error: ...`).
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
- [ ] UI contract next: templates, `chart`/`table`/`image` blocks, Home widgets, discovered sections, dates in formats

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
- [x] Native Music and Photos, declarative screens for other satellites
- [x] Shared renderer for UI contract documents; icons from `icon_name`
- [ ] Rediscover and cache controls in the app
- [x] Move Status onto shared blocks, at parity - UI contract 1.1 (`docs/satellites/status.md`, "Status's migration")
- [ ] Retire Status's previous page and screen once 1.1 is validated
- [x] Specify `media.audio` and `audio.library` from Music's player (`docs/media-audio.md`)
- [ ] Audio: contract groundwork, then the Android and web AudioHosts (`docs/media-audio.md`, "Migration plan")
- [ ] Move Photos, the Locked Folder and Music onto shared blocks and capabilities, at parity (`docs/ui-contract.md`, "Migration")
- [ ] Light theme
- [ ] Icons instead of text glyphs for the remaining Music controls
- [ ] Audio playback validated on a real device

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
    - [x] Phone sync with source-path mapping
- [ ] Music
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
- [ ] Hashed session tokens at rest
- [ ] Periodic security audits, including dependency audits
- [x] Locked Folder encryption at rest (server-side; see its threat model)
- [ ] End-to-end encryption for the Locked Folder (keys never on the server)
