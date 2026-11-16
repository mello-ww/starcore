# Photos functional parity audit (2026-11-06, at 86580d8; marks updated 2026-11-12)

Compared from the code, not the docs:
- **Dedicated web:** `satellites/native/photo/mission_control/page.js`.
- **Dedicated Android:** `mobile/src/photo/*`.
- **Shared interface:** `satellites/native/photo/ui.json`, rendered by `mission_control/ui/*` and `mobile/src/satellites/ui/*`.
- **Server:** `gallery.py` and `api.py`.

Legend:
- **Marks:** ✅ = yes, ◐ = partly or different, ✗ = no.
- **Platforms:** DW = dedicated web, DA = dedicated Android, SW = shared web, SA = shared Android.
- **Fix types:**
  - C = a generic UI contract or renderer feature.
  - S = a Photos server change.
  - J = a Photos `ui.json` change only.
  - N = stays native (no change needed beyond a way to reach it).
- **Priority:** P0 = must have before the shared interface becomes the default; P1 = should have; P2 = optional.
- **Size:** S, M or L.

## Parity matrix

| # | Feature | DW | DA | SW | SA | Gap / difference | Fix | Pri | Size |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Library timeline by month | ✅ | ✅ | ✅ | ✅ | None. The shared view pages and virtualizes; the dedicated views load everything. | – | – | – |
| 2 | Group by camera, flat "All" view | ✅ | ✗ | ✅ fixed in M14 | ✅ fixed in M14 | Only the dedicated web page has it. | J+S: a `choice` state for grouping, plus `gallery?group=` returning `group` and its sort | P1 | M |
| 3 | Filter by kind (photo/video) | ✗ | ✗ | ✅ (Search) | ✅ (Search) | The shared interface is ahead. | – | – | – |
| 4 | Thumbnail size / density | ✗ | ✅ pinch, 3–6 columns | ✅ fixed in M3: small / medium / large | ✅ fixed in M3: pinch | Android users lose pinch density. | C: user-adjustable grid density (pinch on Android, size control on web) | P0 (Android) | M |
| 5 | Summary (counts, size, Pillow/FFmpeg missing, sync state) | ✅ | ✗ | ◐ caption | ◐ caption | The "tools missing" note is lost. | S+J: a text or status block from `gallery` | P2 | S |
| 6 | Albums list (physical / Favorites / custom / bin) | ✅ | ✅ | ✅ grouped | ✅ grouped | The bin is a button rather than a card, and the per-group empty hints are missing. | J | P2 | S |
| 7 | Create album | ✅ | ✅ | ✅ form | ✅ form | – | – | – | – |
| 8 | Rename / delete custom album | ✅ | ◐ delete only (`renameAlbum` unused) | ✅ | ✅ | Shared is ahead on Android. | – | – | – |
| 9 | Add photos to album | ✅ modal | ✗ | ✅ `pick` | ✅ `pick` | Shared is ahead on Android. | – | – | – |
| 10 | Remove from album | ✅ | ✗ | ◐ viewer only | ◐ viewer only | There is no bulk "Remove from album". | J (selection action with `visible: $.editable`; check what `visible` resolves against in a selection) | P2 | S |
| 11 | Album order | added order | added order | ✅ fixed in M1: the album's order | ✅ fixed in M1 | Different behaviour (`page()` always sorts). | Decide: accept, or S: keep the album's own order | P1 | S |
| 12 | Recycle bin: list, restore, erase | ✅ | ✅ | ✅ + bulk | ✅ + bulk | Shared is ahead (bulk). | – | – | – |
| 13 | Bin: "N days left" per item | ✅ | ✅ | ✅ fixed in M1 | ✅ fixed in M1 | Lost per item. | S+J: `subtitle` = days left | P1 | S |
| 14 | Search | ✗ | ✅ in-memory | ✅ server, paged, + albums, kind | ✅ | Shared is ahead (web gets search for the first time). | – | – | – |
| 15 | Map | ✅ Leaflet/OSM, clusters, popup of 12 → viewer | ◐ one marker per photo, Google key needed | ✅ viewport clusters | ◐ same Google key need | A cluster tap zooms in rather than showing a popup grid. The Android key gap is the same on both sides. | – (accept). Optional C: cluster preview | P2 | M |
| 16 | Viewer: image, previous/next, keyboard | ✅ (+ `i` for info) | ✅ swipe | ✅ arrows, Esc | ✅ swipe | – | – | – | – |
| 17 | Viewer: touch swipe on web | ✅ `attachSwipe` | n/a | ✅ fixed in M13 | n/a | Lost on touch browsers. | C (renderer) | P1 | S |
| 18 | Viewer: pinch / zoom image | ✗ | ✅ ZoomableImage | ✗ | ✅ fixed in M3 | Android users lose zoom. | C (renderer: reuse ZoomableImage) | P0 | M |
| 19 | Video playback | ✅ | ✅ | ✅ | ✅ | – | – | – | – |
| 20 | Details panel | ✅ full EXIF + mini-map + map link | ◐ 4 fields | ✅ 12 fields | ✅ 12 fields | Shared lacks aperture, shutter, ISO, focal length and orientation (the viewer field limit is 12), the location mini-map and the link. | S: one composed "Exposure" field. C (optional): field `href` | P2 | S |
| 21 | Favorite from a tile, favorite badge | ✅ | ✅ | ✅ fixed in M11 | ✅ fixed in M11 | No heart on tiles, and favorites can't be seen in the grid. | C: a tile badge or quick action (`item.badge`, or one tile action) | P1 | M |
| 22 | Delete from a tile | ✅ trash badge | via selection | via selection or viewer | via selection or viewer | Acceptable difference. | – | – | – |
| 23 | Selection, bulk actions | ✗ | ◐ long-press → delete only | ✅ Favorite, bin, restore, erase | ✅ | Shared is ahead. Missing: select all, bulk unfavorite, add selection to album. Each item is a sequential request. | C (select all); S (optional bulk routes) | P2 | M |
| 24 | Move to Locked Folder (viewer) | ✅ PIN prompt | ✅ PIN / biometric modal | ✅ fixed in M5 (`secure`) | ✅ fixed in M5 (`secure`) | **Lost.** An action can't ask for an unlock first. | C: an "unlock first" step for an action, provided by a capability (a vault capability from the Locked Folder, the client's own PIN and biometric UI), similar to `pick` | P0 | L |
| 25 | Locked Folder itself (PIN, biometrics, encryption, recovery, move-out) | removed (L8) | removed (L8) | ✅ its own shared interface (L0-L8) | ✅ its own shared interface (L0-L8) | Stays native by design; it only needs a way in from the shared interface. | N + client wiring: an entry point to the Locked Folder on both clients | P0 | S–M |
| 26 | Import from a server folder (scan / import) | ✅ | ✗ (empty text wrongly says "Import some from your Albums tab") | ✅ fixed in M1 | ✅ fixed in M1 | Lost on web. | J: a form with `source` and Scan / Import → existing `scan`/`import` routes. S: add a `message` to their answers. Optional: `file-browser` | P0 | S |
| 27 | Upload, download, share, export (download and share fixed in M12; upload and export not) | ✗ upload, ✗ download | ◐ Share sends a bare authenticated URL (the recipient can't open it) | ✅ download, ◐ share where the browser can | ✅ (share; download on Android 10+) | Nothing worked well anywhere before M12. | C: `download`/`share` action (web: authenticated fetch → save; Android: download → share the file) | P1 | M |
| 28 | Phone sync (background, Wi-Fi only, Sync now, permission) | removed (S0) | removed (S0) | ✗ until S2 | ✗ until S3 | The old sync is removed whole (S0); its replacement is designed below. | C: the `sync` action and `device.media-sync` (S1 to S4) | P0 | L |
| 29 | Settings (source_paths mappings, default sync folder, retention, default import directory) | ✅ tab | ✅ screen | ✅ fixed in P1: a Settings page of forms | ✅ fixed in P1 | `source_paths` is a list of objects: since L4 the contract's form has repeatable rows. | C: repeatable form rows (contract change 2), then J+S: `gallery/settings` and the forms | P0 entry / P2 C | S / M |
| 30 | Offline cache (Android) | n/a | ✅ cached list, "Showing cached photos - offline" | n/a | ✅ fixed in M4 (offline pages) | **Lost.** | C: opt-in per-server page-data cache, forgotten on a Locked Folder move (as `forgetCachedPhoto`) | P0 (Android) | M |
| 31 | Deep link `#/satellite/Photo/LockedFolder` (web) | ✅ | n/a | ✅ fixed in M2 | n/a | Breaks if the shared interface becomes the default. | Client wiring with #25 | P0 | S |
| 32 | Large libraries | ◐ every tile in the DOM | ✗ 50k never loaded | ✅ paged | ✅ virtualized | Shared is far ahead. Picker add of N items saves the album file N times. | S (optional): one album save | P2 | S |
| 33 | Viewer shows the whole photo | ✅ | ✅ | ✅ fixed in M7 | ✅ | A portrait photo on a landscape screen is cropped: the frame is a grid with no sized row, so the image keeps its own height and overflows (a 1080×1920 image is drawn 1538 px tall in a 608 px frame). | C (renderer CSS): give the image the frame's size (`grid-template: 100% / 100%`, or an absolutely placed image) | P0 | S |
| 34 | Page uses the screen's width | ✅ | n/a | ✅ fixed in M8 | n/a | Every shared page except a `dashboard` is capped at 880 px, so Photos fills half of a 16:9 screen. | C: an additive width hint, or full width for a page holding a media grid or map; 1.0/1.1 documents unchanged | P0 | S |
| 35 | Favorites pinned at the top of Folders | ◐ | ◐ | ✅ fixed in M9 | ✅ fixed in M9 | Favorites should sit in Folders, always first, not in a group of its own. | S: `gallery.py` lists Favorites first under the Folders group (clients group consecutive items as sent) | P1 | S |
| 36 | Locked Folder as a folder tile with a lock | ◐ own tab | ◐ own tab | ✅ fixed in M10 | ✅ fixed in M10 | It should be a tile among the folders, with the shared `lock` icon as its thumbnail. | C: a media-grid tile `icon` drawn when there is no `image`, and a per-item action (`own` for this tile, `navigate` for the others); then J+S | P1 | M |
| 37 | Locked Folder in the shared interface | removed (L8) | removed (L8) | ✅ fixed in L0-L8 | ✅ fixed in L0-L8 | Opening it leaves the shared interface for Photo's own page and screens. Retiring those screens would cut the way in. | C + Locked Folder capability: browse, view and move out through the shared viewer while unlocked, the PIN and biometric prompts reused from M5, never a listing without a grant | P0 before retiring the own screens | L |
| 38 | Icons shipped by the Satellite | ◐ `icon.svg`, web only | ✗ shared set only | ✗ shared set only | ✗ | `ui.json` may only name the 34 shared icons, and Android draws no SVG. | C: a declared `icons/` folder, validated by the Engine (no script or external reference, single colour, tinted by the client's tokens), served with a revision, named in the document with a shared icon as fallback; Android adds an SVG renderer once | P2 | M–L |

## Regressions from the gallery, picker, search, map and paging milestones

None found in the dedicated interfaces:
- The five commits didn't touch `mission_control/page.js` or `mobile/src/photo/*`.
- `api.py` only gained things: the new `gallery` and `media` routes, and an `items` branch before the album POST's unchanged `photo_id` branch.
- With Developer Mode off, both clients still open the dedicated screens.

Issues found then in the new shared interface (the stale `_about` text, album order, bin
wording, the Android "Offline" notice for any failure) were fixed in M1. Bulk actions still
run one request per item (#23).

## Roadmap: shortest safe path to making the shared interface the default

**Status (2026-11-11):** M1 to M6 are done; Photos opens in its shared interface by default on
both clients, and M7 to M14 are done; #33 to #38 came from
the owner's review of the shared interface on 2026-11-11.

**The goal these milestones serve:** at a stable release, a new Satellite needs no change to
the Engine, Mission Control or the Android app. Everything it needs on both clients lives in
the Satellite: its `ui.json`, its routes and capabilities, and its own assets. The clients keep
improving until then, but only through generic, reusable features; no component other than
the Satellite itself names a Satellite.

Each milestone is small and testable on its own. The order runs from cheapest to riskiest.

**Required before the shared interface becomes the default**
- **M1. Photos-only fixes** (J+S, S). Changes:
  - import form (#26);
  - days left in the bin (#13);
  - the album-order decision (#11);
  - `_about` text.

  Test: engine tests for the `message`/`subtitle` fields, plus a manual import on both clients.
- **M2. Ways back to the native parts** (client wiring, S–M). From the shared Photos interface, reach:
  - Photo settings and sync (#28, #29);
  - the Locked Folder (#25, #31), with the web deep link kept working.

  Test: navigation tests on both clients, and the Locked Folder still locks when you leave it.
- **M3. Android viewer zoom and grid density** (C renderer, M): #18, #4. Reuse ZoomableImage and `usePinchColumns` in `MediaGrid.tsx`, plus a web size control. Test: renderer tests and a check on the emulator.
- **M4. Android offline page cache** (C, M): #30. Opt in per page or document, keyed per server, never caching Locked Folder data, forgotten on a move, with a correct "Offline" or "Couldn't load" notice. Test: unit tests plus airplane mode on the emulator.
- **M5. "Unlock first" actions** (C + Locked Folder capability, L): #24. Contract, Engine validation, both clients' PIN and biometric prompts, then the "Move to Locked Folder" viewer action in `ui.json`. Test: contract fixtures, a security review, and an end-to-end check with a test PIN on the local demo.
- **M6. Switch the default** (client + docs, S). Shared by default, dedicated in Developer Mode (the reverse of today). Keep the dedicated screens until validated.

**Bugs found after the switch (next)**
- **M7. The viewer shows the whole photo on the web** (C renderer, S): #33. Done: checked in a browser on the local demo with portrait and landscape photos at 1920×1080 and 390 px wide (layout has no Node test).
- **M8. Shared pages use the screen's width on the web** (C, S): #34. Done, with no contract change: Mission Control gives a page holding a media grid or a map the full width (up to Mission Control's 1400 px, as Photo's own page), and keeps its other blocks at 880 px. Tested with a unit test for the rule, and in a browser at 1920×1080 and 390 px (Photos' pages, Status unchanged).

**Should follow soon**
- **M9. Favorites pinned at the top of Folders** (S, S): #35. Done: `gallery/albums` lists Favorites first under Folders; an engine test checks the order and groups, and the web was checked on the local demo.
- **M10. The Locked Folder as a folder tile** (C + J+S, M): #36. Done: `item.icon` and `open` in the contract (Engine validation, fixtures, both renderers), and the tile in Albums, right after Favorites, opening the Locked Folder. Tested with contract fixtures, renderer tests on both clients, engine tests, and on the local demo (web and emulator).
- **M11. Favorite heart on tiles** (C + J, M): #21. Done: `quick` tile actions in the contract (Engine validation, fixtures, both renderers) and the heart toggle on Photos' Library, Search and album grids. Tested with fixtures, renderer tests on both clients, engine tests, and on the local demo (web and emulator).
- **M12. Download and share** (C + native + J, L): #27. Done: `download` and `share` actions in the contract (Engine validation, fixtures), Mission Control's `ui/files.js`, the app's `src/files/` and its Kotlin `StarCoreFilesModule` (MediaStore Downloads, a FileProvider for the share sheet), and both actions in every Photos viewer. Photo's own Android viewer shares the file too. Tested with fixtures, unit tests on both clients, engine tests, and on the local demo (web and emulator).
- **M13. Web viewer touch swipe** (C renderer, S): #17. Done: the shared web viewer moves on a deliberate one-finger sideways swipe, the same rule as Photo's own page, and leaves a swipe that starts on a video to its player. Tested with a unit test for the rule and simulated touches in a mobile-sized browser.
- **M14. Camera grouping and the "All" view** (J+S, plus a contract relaxation, M): #2. Done: `gallery?group=month|camera|all` and a "Group by" choice in the Library. The Library is an offline page, so offline pages may now depend on a choice's state (Engine rule, and the app keeps one collection per value). Tested with engine tests (order, paging, groups), fixtures, the app's offline tests, and on the local demo (web and emulator).

**Before Photo's own page and screens are retired**
- ~~The Locked Folder in the shared interface (#37)~~: done (L0-L8, `satellites/locked_folder.md`).

**Native for now**
These still need client code written for Photo or the Locked Folder. To reach the goal above,
each must move to the contract or to a generic capability before the stable release:
- The Locked Folder internals: PIN, biometrics, encryption, recovery, move-out (#25, then #37).
- Phone sync (#28): removed in S0; a generic device-sync capability replaces it (S1 to S4).

**Towards the stable release**
- Icons shipped by the Satellite (#38).

**Optional (don't block the switch)**
- Summary and tools note (#5).
- Album group hints (#6).
- Exposure details and map link (#20).
- Map cluster preview (#15).
- Select all, bulk unfavorite, add selection to album, bulk routes (#23).
- Bulk remove from album (#10).
- One album save per pick (#32).

## Phone sync (#28): what exists, and the design of its replacement (2026-11-15)

**Status: approved by the owner (2026-11-15). S0 is done: the old sync is removed as the
inventory below lists. Nothing of the new one is implemented yet**; the decisions at the end
stay open until the milestone that needs them. Read from
the code at `5b716a9`. The old sync is removed entirely, then a real automatic backup is built
as a generic capability. The common order with the Locked Folder is in
[Remaining work](remaining-work.md).

### Inventory of the old sync

There are two of them, sharing one ingestion (`SyncService.accept()`):

1. **The standalone listener** (`satellites/native/photo/sync.py`): its own HTTP server on
   `sync_host`:`sync_port`, one shared token accepted in a header **or in the URL**, an HTML
   upload page, plain HTTP only. Each upload is read whole into memory.
2. **The app's background sync:** `POST sync_upload` on the main API with the session, called
   every 15 minutes or more by `react-native-background-fetch` in headless JavaScript, reading
   the phone with `@react-native-camera-roll/camera-roll`.

What the second one does not do, and why it isn't a backup: it runs on a timer, not when a
photo is taken; its cursor is one timestamp, so one file that fails blocks everything newer;
an upload restarts from zero, and the server holds it whole in memory (up to 512 MB); every
folder is sent, with no choice; "Wi-Fi only" doesn't apply when the app is opened; nothing shows
progress or errors; it uses the app's session, which ends 7 days after sign-in; and the manifest
has no `ACCESS_MEDIA_LOCATION`, so Android may hand over photos with their GPS position removed
(to check on a real phone).

| Where | What goes |
|---|---|
| Server code | `photo/sync.py` whole (listener, handler, page, token, activity log); in `photo/api.py` the `sync` and `sync_upload` routes; in `configuration.py` `sync_host`, `sync_port`, the listener restart and its "pending restart" logic; `state.py`'s `sync`; `satellite.py`'s `start`/`stop` hooks; in `commands/photo.py` `photo sync`, the sync line of `photo stats`, the `sync_*` keys of `photo config` |
| Server config | `sync_enabled`, `sync_host`, `sync_port`, `sync_token`, `sync_max_bytes` in `config.default.toml` and `config.toml`; the `data/sync_token` file; the `incoming/` folder |
| Kept | `source_paths` and `sync_default_path` (which album a phone folder joins): the new sync uses them; `library.add_file()` and its `private` check |
| Web | Photo's `page.js`: the "Phone sync" panel, tile and listener log (about 60 lines), and their styles in `page.css` |
| App code | `mobile/src/photo/backgroundSync.ts`, `backgroundSyncTask.ts`, `syncState.ts`, `mediaPermission.ts`; the "Automatic phone sync" section of `PhotoConfigurationScreen.tsx`; `uploadSync` in `photo/api.ts`; `postFile` in `api/client.ts` (nothing else uses it); the two calls in `App.tsx`; the headless task in `index.js` |
| App build | `react-native-background-fetch` and `@react-native-camera-roll/camera-roll` in `package.json`; in the manifest `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` and the comments that go with them (the media permissions come back with the new sync) |
| App storage | `starcore_photo_sync_state:<server>`, removed once at start |
| Tests | `engine/tests/test_photo_sync.py` whole (its configuration tests move to `test_photo.py`); the sync parts of `test_photo.py` (`photo config sync_*`, about 1448-1546), `test_cli.py` (37, 397-407), `test_developer_mode.py` (73, 97, 115-122), `test_configuration.py` (114), `test_locked_folder_security.py` (428-443, against import and the handover until S1 adds the new route); `mobile/__tests__/backgroundSync.test.ts`, `lockedBackgroundSync.test.tsx`, `startupSync.test.tsx`, the sync part of `serverListStartup.test.tsx`; `KNOWN_IMPORTS`' `App.tsx` line |
| Docs | `satellites/photo.md` ("Phone synchronization", "Configuring Photo Sync", "Real automatic phone sync", the route table, the CLI list); `api.md` (342-345); `deployment.md` (167, 318-319); `cli.md` (171, 174); `mission_control.md` (164); `satellites.md` (82, 270, 319, 367); `mobile/README.md` (21, 180); `roadmap.md` (230); `ui-contract.md`'s target row |
| CHANGELOG | a "Removed" entry under Unreleased; the two entries that say settings and phone sync "open Photo's own screens" (174, 250) reworded when that stops being true |

### Design

**Two halves, as for audio.** A Satellite capability, `media.sync` v1, that any Satellite
holding media can provide (Photo does); and a client capability, `device.media-sync`, written
once in the Android app (it replaces the reserved, unclaimed name `device.background-tasks`).
The app finds the provider in the catalog and never names it.

**`media.sync` v1, the provider's side:**

| Operation | Request and answer |
|---|---|
| `status` | `GET ?device=` -> `{accepts: ["image", "video"], max_bytes, chunk_bytes, device: {name, last_seen, received}}` |
| `check` | `POST {device, items: [{sha256, size}]}` (at most 500) -> `{known: [sha256], wanted: [sha256]}`. Known means: in the library, in the bin, erased earlier, or moved somewhere protected. The answer never says which. |
| `upload` | `GET /<sha256>` -> `{offset}`, the bytes already held for this digest. `POST /<sha256>?offset=&size=&name=&folder=&taken=`, the raw body from that offset, at most `chunk_bytes` -> `{offset}`, or at the last byte `{status: "imported" or "duplicate", id}`. Written straight to disk; the whole file's SHA-256 must match before it is taken in; a wrong offset answers `409` with the right one. |
| `devices` (optional) | `GET` -> the devices that sync, for a status page on any client |

**The app's side** (`mobile/src/sync/` and a Kotlin package `sync`, both generic):

- **Detection:** a WorkManager job triggered by MediaStore content changes (images and
  videos), so a new photo starts a run within seconds; a periodic job every 6 hours and a run
  when the app opens catch what a trigger missed (a reboot, a force stop). No timer loop, no
  foreground service left running.
- **The local index** (SQLite, app-private, per server): for each media its MediaStore id,
  folder, size, modification time and generation, then its SHA-256 and a state (`pending`,
  `uploading` with an offset, `done`, `failed` with a reason and a retry count). Items fail
  one by one: a file that can't be read or is refused never blocks the others.
- **Duplicates:** the MediaStore id with size and time says what changed on the phone; the
  SHA-256 says what the server has. A file is hashed once, `check` is asked, and only wanted
  files are sent. After a reinstall or on a new phone, everything is hashed again and nothing
  is sent twice.
- **Folders:** the phone's own folders (MediaStore buckets: Camera, Screenshots, Downloads,
  each app's folder), listed with counts; Camera is on by default, the rest off. The folder's
  path travels as `folder`, which Photo maps to an album with `source_paths`.
- **When:** Wi-Fi only by default, with "Use mobile data" as a switch; "Only while charging"
  off by default; never on a low battery. These are WorkManager constraints, so the system
  enforces them, also for "Sync now" and for opening the app.
- **Cuts:** chunks of `chunk_bytes` (8 MiB by default, set by the provider so it fits the
  proxy in front of it). After any cut the app asks the offset and goes on from there. A run
  stopped by the system (10 minutes, Doze) is rescheduled with backoff; a long run shows a
  progress notification as a `dataSync` foreground job.
- **What the person sees:** on Android the sync screen (reached from the document and from the
  app's settings): on or off, folders, the two switches, and a state line: "Backing up 12 of
  80", "Up to date, 2 min ago", "Waiting for Wi-Fi", "Waiting for the charger", "Permission
  needed", "Sign in again", and the failed items with their reason and "Try again". On the
  web, a Devices page in Photo's own `ui.json` from the provider's `devices` route: each device,
  when it last synced and how much. The web can't sync in the background; uploading from a
  browser is the existing `upload` action.
- **In the contract:** one action, `{"sync": {"capability": "media.sync"}}`, opens the client's
  own sync screen for that provider. A client without `device.media-sync` hides the control.
  The document supplies no text, no route and no setting of the sync itself.
- **Permissions:** `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` (Android 13 and later),
  `READ_EXTERNAL_STORAGE` up to Android 12, `ACCESS_MEDIA_LOCATION` so originals keep their
  position, `POST_NOTIFICATIONS` for the progress notification, `FOREGROUND_SERVICE_DATA_SYNC`.
  Asked when sync is turned on, never from the background. On Android 14 and later "selected
  photos only" is not enough: the screen says so and offers the system setting. No exemption
  from battery optimisation is requested.
- **Authentication:** see decision 1. Recommended: a **device credential** the Engine issues
  for one capability (`POST /api/auth/devices`, with a full session): it can call only the
  routes of that capability's provider, so a sync credential can add media and read nothing;
  it has no 7-day end; it is stored hashed on the server, listed and revoked with the
  sessions, and kept on the phone under an Android Keystore key. Signing out revokes it and
  removes the local index.
- **Transfer:** the same origin the app uses, never another host after a redirect; the screen
  warns when the server address is plain HTTP; integrity by the SHA-256 the server checks; the
  provider limits size, partial uploads per device (4) and their age (7 days).
- **Deleted media:** it is a one-way backup. Deleted or edited on the phone: the server keeps
  what it has (an edit is a new file). Moved to the bin on the server: not sent again. Erased
  on the server: not sent again either, because the provider keeps the digest (decision 2).
  Moved somewhere protected: answered as known. Nothing is ever deleted from the phone.

### What is tested where

| Where | What |
|---|---|
| Engine tests | the protocol: `check`, resuming, a wrong offset, a wrong digest, limits, stale partials, erased and protected digests answered as known, a large file without holding it in memory, the device credential reaching only its capability's routes |
| Jest | the sync screen's states and switches against a fake native module, the permission flow, the `sync` action hidden without the capability or a provider, the contract fixtures |
| JVM unit tests (new for the app) | the index's state machine, chunk planning and backoff, without a device |
| Emulator | a pushed file is detected and sent; folders respected; airplane mode in the middle of a video, then it resumes; the app killed and the run still happens; a reboot; a metered network and the charger simulated with `adb`; Doze forced; Android 13 and 14 permission dialogs |
| A real phone only | the camera's own files (HEIC, motion photos, 4K video); position kept in the original; a night in Doze; the maker's battery saver killing the app; Wi-Fi to mobile data while sending; a reboot with the phone not yet unlocked; hours of backlog and heat |

### Milestones

| # | What | Contract | Main files | Model |
|---|---|---|---|---|
| S0 (done) | Remove the old sync (the inventory above) | none; the reserved client name changes in S2 | as listed | Sonnet 5.5 high |
| S1 | `media.sync` v1 in the vocabulary and in Photo: the four routes, streamed to disk, digests of erased items; the Engine's device credentials if decision 1 says so | vocabulary: one Satellite capability | `contracts/ui/vocabulary.json`, `photo/backup.py` (new) and `api.py`, `library.py` (erase records the digest), `engine/starcore/auth.py` and `api/server.py` | Opus 5.5 xhigh |
| S2 | The `sync` action and `device.media-sync`; Photo's button and Devices page | **contract change 4** | `ui_contract.py`, fixtures, both clients' contract and action runners, `photo/ui.json` | Opus 5.5 high |
| S3 | The app's sync: the Kotlin package (workers, MediaStore, index, uploader, notification), `mobile/src/sync/` (screen, state), the manifest, `App.tsx` | none | `mobile/android/app/src/main/java/.../sync/`, `mobile/src/sync/`, `AndroidManifest.xml` | Opus 5.5 xhigh |
| S4 | Emulator runs from the table above; then the owner's phone | none | none | Opus 5.5 high |
| S5 | Security review of S1 to S3 (the credential, the upload route, what the phone stores) | none | none | Fable 5.2 high |

### Decisions for the owner

1. **Credential:** a device credential limited to `media.sync` (recommended: backup goes on
   without signing in every week, and a stolen one reads nothing), or the app's session as
   today (no Engine change; backup stops 7 days after each sign-in until the app is opened and
   signed in again).
2. **Erased photos:** the server remembers their digest so a phone never sends them back
   (recommended), or forgets them, so a reinstalled app uploads them again.
3. **Defaults:** Camera only, Wi-Fi only, charging not required (recommended).
4. **When the old sync goes:** first, in S0 (recommended: one code path; production keeps the
   old one until the whole stage is pushed and deployed), or only once S3 works.

## The rest of Photos, after the Locked Folder and the sync

| # | What | Contract | Main files | Tests | Model |
|---|---|---|---|---|---|
| P1 (done) | Settings (#29) as forms: the `source_paths` mappings as repeatable rows (the `rows` field kind arrives with the Locked Folder's L4), retention, default import folder, default album; `own: "settings"` goes | uses contract change 2 | `photo/ui.json`, `photo/api.py` (a `view/settings` route), `configuration.py` | Engine: the document's routes; both clients' form tests with rows added, removed and refused | Opus 5.5 high |
| P2 | Icons shipped by a Satellite (#38): an `icons/` folder named in the manifest; the Engine validates each SVG (no DOCTYPE, an allow-list of shape elements and attributes, `currentColor` only, no `style`, `script`, `use`, `image`, `href` or event attribute, 8 KB each, 32 at most) and serves it with a revision; a document names `{"own": "<name>", "fallback": "<shared icon>"}`; both clients check again and tint it; Android gets its SVG renderer | **contract change 5** | `satellite_loader.py`, `ui_contract.py`, `api/server.py`, fixtures, `mission_control/ui/icons.js`, `mobile/src/satellites/ui/` | Engine: every refused construct as a fixture; both clients draw the fallback for a refused or missing icon | Opus 5.5 high |
| P3 | Remove Photo's `page.js`, `page.css`, `mobile/src/photo/`, its routes in `MainTabs.tsx` and its `DEDICATED_SCREENS` entry, once the owner has validated L5, S4 and P1 | none | those | the suites; `KNOWN_IMPORTS` loses `MainTabs.tsx` and `KNOWN_COUPLINGS` its Photo count | Sonnet 5.5 medium |
