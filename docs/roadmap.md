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

### Known limitations

- The Android app has no light theme (web Music has one).
- Android Music still draws some controls (♥/♡, shuffle, repeat, transport) as text glyphs,
  not icons; some phones render them as emoji.
- The Android Config tab keeps a sliders icon, so it does not look identical to Settings.
- Mission Control still carries hidden legacy markup and styles from the previous design
  (the starfield and asteroid belt in `index.html`, their rules in `style.css`).
- Locked Folder files are protected by access control and a hashed PIN, but not encrypted
  at rest.
- The Signal Bus is not implemented yet (`engine/starcore/signals.py` is empty).
- Developer Mode and Space Mode do not exist yet.

### Security review (2026-11-02)

Non-destructive review; nothing was changed in response yet.

Confirmed weaknesses:

- **Unbounded JSON request bodies.** `_read_json_body()` reads the whole `Content-Length`
  into memory, including on `/api/auth/login`, which needs no session. Anyone who can reach
  the server can exhaust its memory. The default bind address `127.0.0.1` limits exposure.
- **No sign-in throttling.** `/api/auth/login` has no attempt limit or delay (the Locked
  Folder PIN does). Exposure beyond localhost makes password guessing possible.

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

Checked and fine: PBKDF2-SHA256 (260,000 iterations, per-secret salt) and constant-time
comparison for the password and Locked Folder PIN; `HttpOnly; SameSite=Lax` session cookies
(`Secure` over HTTPS); path traversal refused for Mission Control and satellite assets;
Locked Folder unlock rate-limited per session and kept in memory only; Android tokens in the
Keychain with app backup disabled; no shell commands built from user input; the engine has
no required third-party Python dependencies.

## Engine

- [x] Bootstrap
- [x] Configuration (TOML, defaults merged on upgrade, edits from Mission Control)
- [x] API (sessions, satellites, commands, configuration, restart and shutdown)
- [x] Authentication (single administrator, sessions per device, revocation)
- [x] HTTPS with a provided certificate
- [ ] Storage (satellites keep their own SQLite and JSON stores today)
- [ ] Signal Bus

## Mission Control

- [x] Dashboard (Home)
- [x] Authentication
- [x] StarCore design language and accent presets
- [x] Satellite pages, configuration dialogs and lifecycle controls
- [ ] Developer Mode
- [ ] Space Mode

## Android app

- [x] Multiple servers, sign-in and per-server biometric app lock
- [x] StarCore design language with live accent
- [x] Native Music and Photos, declarative screens for other satellites
- [ ] Light theme
- [ ] Icons instead of text glyphs for the remaining Music controls
- [ ] Audio playback validated on a real device

## Native Satellites

- [x] Status
- [x] Files (File Explorer)
- [x] Locked Folder (PIN, lockout, isolation from File Explorer)
    - [ ] Move Locked Folder into Photos
    - [ ] Encryption at rest
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

- [ ] Request body size limit and sign-in throttling (see the review above)
- [ ] Hashed session tokens at rest
- [ ] Periodic security audits, including dependency audits
- [ ] Encryption improvements (Locked Folder at rest)
