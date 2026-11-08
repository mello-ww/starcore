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
- **UI contract 1.1** - only additions, so every 1.0 document still works:
  - blocks `chart` (time series, or bars), `table`, `choice` (a segmented control over page
    state), `status` (a dot and a word) and `code` (JSON, with Copy);
  - `detail` on fields and metrics, `trend` (a sparkline) and `action` on metrics, `tone` on
    list items, the `eyebrow` text style;
  - page `state`, named `sources` and the `dashboard` template; a document `header`;
    developer-only navigation;
  - `widgets`, summaries a client shows on Home;
  - formats `bitrate`, `byterate`, `time`, `date`, `datetime` and `relative`, and the same
    formatting in the Engine (`format_value`) for Satellites that build text;
  - a 1.0 document that uses a 1.1 feature is refused, so it always declares what it needs.
- **Status is drawn by the shared renderers.** Its interface is now `ui.json` (with a `view`
  route that shapes its snapshot for display) on Mission Control and Android, at parity with
  its previous screens - see "Status's migration" in `docs/satellites/status.md`. Its previous
  page and screen remain for one release: in Developer Mode on the web, and for servers older
  than this one on Android.
- **`audio.library` capability (v1).** Music provides it from its existing routes, so any client
  or Satellite can find an audio library through `GET /api/catalog` without naming Music. A
  capability may now have optional operations, and an operation its version doesn't define is
  refused. The reserved client capability `media.audio-playback` is now `media.audio`. See
  `docs/media-audio.md`.
- **Android: one shared audio player.** The player, its queue, effects, downloads, Connect and
  the floating player UI moved to `mobile/src/media/` (the AudioHost). It plays from the
  catalog's `audio.library` provider, with Music's routes as the fallback on older servers.
  Music also declares `audio.session`, its queue, history, radio, preferences, likes and
  Connect. Nothing about playback changes for listeners.
- **`audio.session` capability (v1).** The playback session beside an audio library is now in
  the shared vocabulary: `queue` is required; `history`, `radio`, `preferences`, `favorites`,
  `stream` and `connect` are optional, and the Engine checks declarations like any other.
  The Android player sends nothing for an operation a provider doesn't offer.
- **Mission Control: one shared audio player.** The player, its queue, effects, Media Session,
  Connect, the floating bar and the top-bar disc moved to `mission_control/media/`, started by the
  shell after sign-in. It plays from the catalog's `audio.library` provider, so the bar, disc and
  saved queue are there on every page and after a reload, before Music's page is opened. Music's
  page keeps its library views and adds its track menu and links to the player.
- **UI contract 1.2: the `play` action.** `{"play": {"search": ...}}` plays what the catalog's
  `audio.library` provider finds, through the client's audio host. Both clients now offer the
  `media.audio` client capability, so any Satellite can play audio without naming the one that
  provides it.
- **Scalable media gallery: server paging and Android virtualization.** A media-grid can page
  through its provider (`more`, with the provider's own cursor): one page at a time, stale pages
  dropped, loading and error states with retry, a refresh that reloads as many pages as were
  loaded, and a selection and viewer that work across pages. On Android a grid that is a page's
  main content is now a virtualized list (memory measured flat at about 130-200 MB while
  scrolling through thousands of items on the emulator); the web draws the grid in chunks the
  browser skips off screen. A map can load what is on screen (`viewport`), with the provider's
  own clusters. Photo's lists take `limit` and `cursor` (stable keyset paging; without them they
  answer everything, as before), its map answers by area with bounded clusters, and its
  `media.gallery` list pages for the picker.
- **UI contract 1.2: `search` and `map` blocks.** A search field bound to page state (results
  reload as the person types, and the field keeps its focus), and located items on an
  interactive map with clusters that stay a handful of markers for thousands of items, opening
  the shared viewer. Each client draws the map it already had (Leaflet and OpenStreetMap on the
  web, react-native-maps on Android): no new map service or key.
- **Photo's shared Search and Map (preview).** Photo's `ui.json` adds Search (file name, camera,
  lens, date and album names, with a Photos/Videos filter) and Map pages, bound to new
  read-only `gallery/search` and `gallery/map` routes. Photo's own page and screens remain the
  default.
- **A reusable media picker (UI contract 1.2's `pick` action).** Any interface can let a
  person choose images or videos, one or several, from whichever Satellite provides the new
  `media.gallery` capability, through the client's picker (`media.picker`, on both clients:
  the shared media-grid with confirm and cancel). The route gets references with the
  provider's identity, never paths. Photo provides `media.gallery` (its active library only,
  never the recycle bin or the Locked Folder), and its shared Album page's "Add photos" uses
  the picker.
- **UI contract 1.2: the `media-grid` block and a shared media viewer.** A grid of images and
  videos from a Satellite's own routes: groups, responsive columns, 60 tiles at a time as it
  scrolls, video badges, loading and error states, a selection with the document's actions,
  and a full-screen viewer (image, video playback, details, actions). Drawn by both clients'
  shared renderers; nothing in it is specific to Photo.
- **UI contract 1.2: preview documents.** `"preview": true` keeps a Satellite's own page or
  screen as the default and offers the shared interface in Developer Mode, while a migration
  reaches parity.
- **Photo's shared Library and Albums (preview).** Photo's new `ui.json` draws its library,
  albums, album pages and recycle bin with the shared gallery, bound to new read-only
  `gallery` routes. Photo's own page and screens remain the default; search, map, import,
  sync, settings and the Locked Folder stay there.
- **UI contract 1.2: `image` and `media-list` blocks.** Images from a Satellite's own routes,
  loaded with the client's session, with sizes, shapes, a loading placeholder and an error
  state; and rows with a thumbnail, title, subtitle, metadata and any action. Drawn by both
  clients' shared renderers; no Satellite uses them yet.
- **Home widgets.** Home on both clients draws every Satellite's widgets; neither names Status
  any more (the Android app keeps its Status card for older servers).
- Mission Control's charts, meters and sparklines, and the app's column chart, meter, bars and
  sparkline, are shared components now (`mission_control/ui/charts.js`,
  `mobile/src/components/charts.tsx`).

### Changed

- **UI contract 1.2: offline pages.** A page with `"offline": true` is kept by the Android app
  to show while StarCore can't be reached: its data and the first pages its media-grid loaded,
  per server, session, Satellite and collection, with the usual offline notice, and live again
  as soon as StarCore answers. Bounded (12 collections per server, 512 KB each, 7 days), never
  holding a token, URL or image, and forgotten after any action on the Satellite, on a 401/403,
  on sign-in, sign-out and server removal. Photos' shared Library, Albums and album pages use
  it; Photo's own screens forget it when they delete a photo or move one to the Locked Folder.
  Mission Control keeps nothing.
- **UI contract 1.2: the `secure` action.** In a media viewer's or selection's actions,
  `{"secure": {"capability": "media.vault", "operation": "move_in"}, "item": "$.id"}` runs one
  protected operation on the items, behind the client's own unlock prompt, as one request for a
  whole selection. Only the operations the vocabulary's `secure_operations` lists are allowed
  (so far `media.vault` / `move_in`), only on the document Satellite's own `media.gallery`
  items (the Engine now validates a document against its Satellite's `[provides]`), and with no
  route, prompt or PIN field of the document's own. Contract fixtures cover each rule; the
  clients draw it from the next milestones on.
- **Moving into the Locked Folder without opening it (server).** An unlock can ask for a
  single-use grant for one move instead (`for: {operation: "move_in", items}`): bound to the
  session, the exact items and 60 seconds, used up by the first `move_in` whatever its outcome,
  and never an unlock, so the vault stays locked and nothing needs locking again. `move_in`
  takes references (`{provider, capability, id}`), which the Engine resolves through the
  `media.gallery` provider it knows (`starcore/capabilities.py`) and checks again at the moment
  of each move. Photo's `media.gallery` gains an optional `resolve` operation, and the Locked
  Folder provides `media.vault`, with no operation that lists or reads the vault. Photo's library
  now refuses to remove a binned photo for a move, under one lock with binning and restoring.
- **Offline pages keep only what they show.** The app keeps only the fields a page's blocks
  bind, and never a field the page names in `"offline": {"omit": [...]}`, at any depth. Photo
  omits each item's GPS location and its folder on the server, which the first version kept in
  the phone's unencrypted app storage. That store (`starcore_ui_offline:v1`) is removed when the
  app starts, for every server; the new one is `v2`.
- **The shared media viewer zooms, and media-grids take the person's own size.** On Android an
  image in the viewer pinches to zoom and, zoomed, pans with one finger or zooms back on a
  double tap, without taking the swipe between items; it is Photo's own zoomable image, now
  shared (Photo's viewer keeps its two-finger pan). A media-grid's thumbnail size changes with a
  pinch on Android (Photo's own pinch, now shared) and a small, medium and large pill on the
  web, remembered per server, Satellite and grid, keeping the scroll position, selection and
  paging. No contract change. On Android a grid that reaches its end while a page is arriving
  now asks for the next one at once, instead of waiting for the next scroll.
- **UI contract 1.2: the `own` action** opens a Satellite's own interface (its `page.js`, its
  native screens) at a section it names, from the shared interface - the bridge to what stays
  native during a migration. It reaches no route; a client without an own interface hides it,
  and Back returns to the shared interface. Photos' shared Albums page uses it for "Settings
  and phone sync" and "Locked Folder", which open Photo's own screens with their PIN and
  permissions unchanged. `#/satellite/Photo/LockedFolder` keeps opening Photo's own page while
  Developer Mode shows the shared interface.
- **Photos' shared interface (preview) moves closer to parity**: an "Import from a folder" page
  (check a server folder, then import it, through the existing `scan` and `import` routes, which
  now also answer with a readable `message`), the days each item has left in the recycle bin,
  and albums in their own order instead of newest first. Photo's own page and screens are
  unchanged and remain the default.
- The shared renderers no longer call a page "offline" or "not answering" when StarCore answered
  with an error: the Android notice says "Not refreshed" and the web one "This page could not be
  refreshed", keeping "Offline" for when StarCore can't be reached.
- Mission Control's files and Satellite assets are served `no-cache` with an ETag (revalidated)
  instead of `no-store`.
- The Android Satellites list refreshes when you return to it.
- A Satellite with both a `ui.json` and a `page.js` gets the shared interface on the web; its
  `page.js` is the fallback, and Developer Mode can switch between them.
- The shared renderers pause while a browser tab is hidden or the app is in the background,
  keep the last data (dimmed, with its age) when a refresh fails, and offer a retry when the
  first one does.

### Fixed

- **The Locked Folder locks again after a failed move from Photos on the web.** A move that
  failed after the PIN (encryption running, a full disk) left that browser session unlocked
  until the time limit; it now locks again whatever the outcome, and a lock that can't be sent
  says when the vault locks by itself instead of reporting success.
- On Android, a Satellite screen's notices now appear above the floating player instead of
  behind it.
- Mission Control's "Sleep timer: end of this track" now stops playback when the track ends,
  also with gapless playback or a crossfade, which used to move straight into the next track.
  While it is set, no next track is lined up.

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
