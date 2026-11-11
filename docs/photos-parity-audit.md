# Photos functional parity audit (2026-11-06, at 86580d8)

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
| 2 | Group by camera, flat "All" view | ✅ | ✗ | ✗ | ✗ | Only the dedicated web page has it. | J+S: a `choice` state for grouping, plus `gallery?group=` returning `group` and its sort | P1 | M |
| 3 | Filter by kind (photo/video) | ✗ | ✗ | ✅ (Search) | ✅ (Search) | The shared interface is ahead. | – | – | – |
| 4 | Thumbnail size / density | ✗ | ✅ pinch, 3–6 columns | ✗ fixed `size` | ✗ fixed `size` | Android users lose pinch density. | C: user-adjustable grid density (pinch on Android, size control on web) | P0 (Android) | M |
| 5 | Summary (counts, size, Pillow/FFmpeg missing, sync state) | ✅ | ✗ | ◐ caption | ◐ caption | The "tools missing" note is lost. | S+J: a text or status block from `gallery` | P2 | S |
| 6 | Albums list (physical / Favorites / custom / bin) | ✅ | ✅ | ✅ grouped | ✅ grouped | The bin is a button rather than a card, and the per-group empty hints are missing. | J | P2 | S |
| 7 | Create album | ✅ | ✅ | ✅ form | ✅ form | – | – | – | – |
| 8 | Rename / delete custom album | ✅ | ◐ delete only (`renameAlbum` unused) | ✅ | ✅ | Shared is ahead on Android. | – | – | – |
| 9 | Add photos to album | ✅ modal | ✗ | ✅ `pick` | ✅ `pick` | Shared is ahead on Android. | – | – | – |
| 10 | Remove from album | ✅ | ✗ | ◐ viewer only | ◐ viewer only | There is no bulk "Remove from album". | J (selection action with `visible: $.editable`; check what `visible` resolves against in a selection) | P2 | S |
| 11 | Album order | added order | added order | newest first | newest first | Different behaviour (`page()` always sorts). | Decide: accept, or S: keep the album's own order | P1 | S |
| 12 | Recycle bin: list, restore, erase | ✅ | ✅ | ✅ + bulk | ✅ + bulk | Shared is ahead (bulk). | – | – | – |
| 13 | Bin: "N days left" per item | ✅ | ✅ | ✗ global note | ✗ global note | Lost per item. | S+J: `subtitle` = days left | P1 | S |
| 14 | Search | ✗ | ✅ in-memory | ✅ server, paged, + albums, kind | ✅ | Shared is ahead (web gets search for the first time). | – | – | – |
| 15 | Map | ✅ Leaflet/OSM, clusters, popup of 12 → viewer | ◐ one marker per photo, Google key needed | ✅ viewport clusters | ◐ same Google key need | A cluster tap zooms in rather than showing a popup grid. The Android key gap is the same on both sides. | – (accept). Optional C: cluster preview | P2 | M |
| 16 | Viewer: image, previous/next, keyboard | ✅ (+ `i` for info) | ✅ swipe | ✅ arrows, Esc | ✅ swipe | – | – | – | – |
| 17 | Viewer: touch swipe on web | ✅ `attachSwipe` | n/a | ✅ fixed in M13 | n/a | Lost on touch browsers. | C (renderer) | P1 | S |
| 18 | Viewer: pinch / zoom image | ✗ | ✅ ZoomableImage | ✗ | ✗ | Android users lose zoom. | C (renderer: reuse ZoomableImage) | P0 | M |
| 19 | Video playback | ✅ | ✅ | ✅ | ✅ | – | – | – | – |
| 20 | Details panel | ✅ full EXIF + mini-map + map link | ◐ 4 fields | ✅ 12 fields | ✅ 12 fields | Shared lacks aperture, shutter, ISO, focal length and orientation (the viewer field limit is 12), the location mini-map and the link. | S: one composed "Exposure" field. C (optional): field `href` | P2 | S |
| 21 | Favorite from a tile, favorite badge | ✅ | ✅ | ✅ fixed in M11 | ✅ fixed in M11 | No heart on tiles, and favorites can't be seen in the grid. | C: a tile badge or quick action (`item.badge`, or one tile action) | P1 | M |
| 22 | Delete from a tile | ✅ trash badge | via selection | via selection or viewer | via selection or viewer | Acceptable difference. | – | – | – |
| 23 | Selection, bulk actions | ✗ | ◐ long-press → delete only | ✅ Favorite, bin, restore, erase | ✅ | Shared is ahead. Missing: select all, bulk unfavorite, add selection to album. Each item is a sequential request. | C (select all); S (optional bulk routes) | P2 | M |
| 24 | Move to Locked Folder (viewer) | ✅ PIN prompt | ✅ PIN / biometric modal | ✗ | ✗ | **Lost.** An action can't ask for an unlock first. | C: an "unlock first" step for an action, provided by a capability (a vault capability from the Locked Folder, the client's own PIN and biometric UI), similar to `pick` | P0 | L |
| 25 | Locked Folder itself (PIN, biometrics, encryption, recovery, move-out) | ✅ (LF page module) | ✅ LockedFolderTab | ✗ | ✗ | Stays native by design; it only needs a way in from the shared interface. | N + client wiring: an entry point to the Locked Folder on both clients | P0 | S–M |
| 26 | Import from a server folder (scan / import) | ✅ | ✗ (empty text wrongly says "Import some from your Albums tab") | ✗ | ✗ | Lost on web. | J: a form with `source` and Scan / Import → existing `scan`/`import` routes. S: add a `message` to their answers. Optional: `file-browser` | P0 | S |
| 27 | Upload, download, share, export (download and share fixed in M12; upload and export not) | ✗ upload, ✗ download | ◐ Share sends a bare authenticated URL (the recipient can't open it) | ✅ download, ◐ share where the browser can | ✅ (share; download on Android 10+) | Nothing worked well anywhere before M12. | C: `download`/`share` action (web: authenticated fetch → save; Android: download → share the file) | P1 | M |
| 28 | Phone sync (background, Wi-Fi only, Sync now, permission) | status only (Dev Mode log) | ✅ | ✗ | ✗ | Device-side; registered in `App.tsx`, so it doesn't depend on the Photos screen. | N: reach `PhotoConfigurationScreen` from the shared interface | P0 | S |
| 29 | Settings (source_paths mappings, default sync folder, retention, default import directory) | ✅ tab | ✅ screen | ✗ | ✗ | `source_paths` is a list of objects; the contract's form has no repeatable rows. | N for now (entry point, as #28). C later: repeatable form rows | P0 entry / P2 C | S / M |
| 30 | Offline cache (Android) | n/a | ✅ cached list, "Showing cached photos - offline" | n/a | ✗ (only the document is cached; the notice says "Offline" for any failure) | **Lost.** | C: opt-in per-server page-data cache, forgotten on a Locked Folder move (as `forgetCachedPhoto`) | P0 (Android) | M |
| 31 | Deep link `#/satellite/Photo/LockedFolder` (web) | ✅ | n/a | ✗ | n/a | Breaks if the shared interface becomes the default. | Client wiring with #25 | P0 | S |
| 32 | Large libraries | ◐ every tile in the DOM | ✗ 50k never loaded | ✅ paged | ✅ virtualized | Shared is far ahead. Picker add of N items saves the album file N times. | S (optional): one album save | P2 | S |
| 33 | Viewer shows the whole photo | ✅ | ✅ | ✅ fixed in M7 | ✅ | A portrait photo on a landscape screen is cropped: the frame is a grid with no sized row, so the image keeps its own height and overflows (a 1080×1920 image is drawn 1538 px tall in a 608 px frame). | C (renderer CSS): give the image the frame's size (`grid-template: 100% / 100%`, or an absolutely placed image) | P0 | S |
| 34 | Page uses the screen's width | ✅ | n/a | ✅ fixed in M8 | n/a | Every shared page except a `dashboard` is capped at 880 px, so Photos fills half of a 16:9 screen. | C: an additive width hint, or full width for a page holding a media grid or map; 1.0/1.1 documents unchanged | P0 | S |
| 35 | Favorites pinned at the top of Folders | ◐ | ◐ | ✅ fixed in M9 | ✅ fixed in M9 | Favorites should sit in Folders, always first, not in a group of its own. | S: `gallery.py` lists Favorites first under the Folders group (clients group consecutive items as sent) | P1 | S |
| 36 | Locked Folder as a folder tile with a lock | ◐ own tab | ◐ own tab | ✅ fixed in M10 | ✅ fixed in M10 | It should be a tile among the folders, with the shared `lock` icon as its thumbnail. | C: a media-grid tile `icon` drawn when there is no `image`, and a per-item action (`own` for this tile, `navigate` for the others); then J+S | P1 | M |
| 37 | Locked Folder in the shared interface | ✅ | ✅ | ✗ opens the own screens | ✗ | Opening it leaves the shared interface for Photo's own page and screens. Retiring those screens would cut the way in. | C + Locked Folder capability: browse, view and move out through the shared viewer while unlocked, the PIN and biometric prompts reused from M5, never a listing without a grant | P0 before retiring the own screens | L |
| 38 | Icons shipped by the Satellite | ◐ `icon.svg`, web only | ✗ shared set only | ✗ shared set only | ✗ | `ui.json` may only name the 34 shared icons, and Android draws no SVG. | C: a declared `icons/` folder, validated by the Engine (no script or external reference, single colour, tinted by the client's tokens), served with a revision, named in the document with a shared icon as fallback; Android adds an SVG renderer once | P2 | M–L |

## Regressions from the gallery, picker, search, map and paging milestones

None found in the dedicated interfaces:
- The five commits didn't touch `mission_control/page.js` or `mobile/src/photo/*`.
- `api.py` only gained things: the new `gallery` and `media` routes, and an `items` branch before the album POST's unchanged `photo_id` branch.
- With Developer Mode off, both clients still open the dedicated screens.

Issues in the new shared interface:
1. **Stale description:** the `_about` text in `ui.json` still says Search and Map stay on the dedicated screens.
2. **Album order:** shared album pages are newest first, while the dedicated ones keep the album's own order (#11).
3. **Bin wording:** the shared bin only shows a global retention note (#13).
4. **Error wording:** the Android shared notice says "Offline" for any load failure.
5. **Bulk actions:** they run one request per item, one after another. 500 selected items means 500 requests, then a reload of every loaded page.

## Roadmap: shortest safe path to making the shared interface the default

**Status (2026-11-11):** M1 to M6 are done; Photos opens in its shared interface by default on
both clients, and M7 to M13 are done. M14 is next; #33 to #38 came from
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
- M14. Camera grouping and the "All" view (#2).

**Before Photo's own page and screens are retired**
- The Locked Folder in the shared interface (#37), so the way in no longer leads to the own screens.

**Native for now**
These still need client code written for Photo or the Locked Folder. To reach the goal above,
each must move to the contract or to a generic capability before the stable release:
- The Locked Folder internals: PIN, biometrics, encryption, recovery, move-out (#25, then #37).
- Phone sync and its background task (#28): a generic device-sync capability.
- The `source_paths` mappings editor (#29), until repeatable form rows exist.
- The dedicated web's sync listener log (Developer Mode).

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
- Repeatable form rows (#29).
