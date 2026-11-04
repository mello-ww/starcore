# Changelog

All notable changes to StarCore. Versions follow [semver](https://semver.org/); the version
itself lives in the `VERSION` file (see `docs/releasing.md`).

## Unreleased

### Added

- **UI contract 1.0** (`docs/ui-contract.md`). A Satellite can describe its interface in a
  `ui.json`, using pages, navigation and 11 blocks bound to its own routes' data, and get a
  page in Mission Control and a screen in the Android app with no client code of its own.
  Each client renders it with its own components; neither runs code it receives.
- **Satellite capabilities.** A Satellite declares what it offers others under `[provides]`.
  File Explorer provides `files.browse`, used by the shared `file-browser` block and by
  Mission Control's folder picker, which no longer looks for File Explorer by name.
- **Catalog and rediscovery.**
  - `GET /api/catalog` lists every capability's providers.
  - `GET /api/satellites` adds `catalog_revision` and, for each Satellite, `icon_name`,
    `provides` and `ui`.
  - `GET /api/satellites/<name>/ui` serves the document with an ETag.
  - A **Rediscover** button (`POST /api/catalog/rediscover`) re-reads that metadata from disk
    without loading code; a new Satellite folder is reported and loads at the next restart.
- **Icons on Android** come from each Satellite's `icon_name` (shared icon set).
- **Shared contract tests** (`contracts/ui/`): the Engine, Mission Control and the Android app
  check the same vocabulary and fixtures. `test_client_modularity.py` fails when generic
  client code names a Satellite.
- **Showcase** example Satellite (`examples/satellites/native/showcase/`), using every block.

### Changed

- Mission Control's files and Satellite assets are served `no-cache` with an ETag (revalidated)
  instead of `no-store`.
- The Android Satellites list refreshes when you return to it.

## 0.1.0-alpha.1 - unreleased

The first Alpha: a stable, reproducible checkpoint of the Engine, Mission Control, the native
Satellites and the Android app, deployed on a Linux server behind HTTPS. It is for testing by
the people running it, not a feature-complete 1.0 - see "Known limitations" in
`docs/releases/v0.1.0-alpha.1.md`.

### Included

- **Engine** - Satellite discovery and lifecycle, TOML configuration with automatic defaults,
  the typed CLI (interactive, and one-shot against a running StarCore), Mission Control's API,
  single-administrator authentication with 7-day sessions.
- **Mission Control** - the StarCore design language across Home, Satellites, Configuration
  and every Satellite page; Developer Mode as a visibility preference.
- **Satellites** - Music (library, playback, queue, playlists, Connect between devices),
  Photo (library, albums, favorites, map, thumbnails, phone backup), Locked Folder (PIN,
  encryption at rest, persistent lockouts, recovery key), File Explorer, Status (health and
  history) and the Docker link Satellite.
- **Android app** - multiple servers, sign-in with optional biometric unlock, Home, Satellites,
  Music, Photos with Locked Folder, Status, Developer Mode.
- **Linux deployment** - `deploy/linux/install.sh`, a hardened systemd unit and the nginx
  HTTPS site (`docs/deployment.md`, "Linux server (systemd)").

### Added in this release

- One version source: the top-level `VERSION` file, read by the Engine at runtime and by the
  Android build. Build number, commit and date come from Git; nothing is hard-coded.
- About sections with version, channel, build, commit and build date: Mission Control
  (Configuration > About, plus a version label at the bottom of the sidebar) and Android
  (Settings > About, showing the app and the connected Engine separately, plus a version line
  at the bottom of Settings). Both have **Copy build info** for bug reports.
- The Engine logs its version at startup: `StarCore 0.1.0-alpha.1 (alpha, build N, <sha>)`.
- Signed, standalone release APK (`mobile/scripts/build-release.ps1`): JS bundle embedded,
  signed with a release key kept outside the repository, verified with `apksigner`,
  `versionCode` derived from the version so updates install in order.
- Release, signing, backup and rollback documentation (`docs/releasing.md`).

### Security

- **A fresh install can no longer be claimed through a reverse proxy or from the LAN.**
  Before the administrator exists, the API answers only a direct client on the server itself;
  everyone else sees just the setup screen, which requires a one-time setup code printed in
  StarCore's startup output. Guesses are throttled.
- **Sign-in throttling is per real client behind the proxy.** It uses the `X-Real-IP` nginx
  sets (believed only from the same machine), so one client's failed guesses can no longer
  lock everyone out.
- The CLI bridge (`/api/cli/run`) refuses any request a proxy forwarded, in addition to nginx
  blocking every `/api/cli` path variant.
- nginx site: 2 GB uploads, unbuffered streaming, `Secure` session cookie, HSTS.

### Changed

- The Android app assumes `https://` for a public host name typed without a scheme (a LAN
  address, `localhost` or `host:port` still defaults to `http://`).
