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
| 17 | Viewer: touch swipe on web | ✅ `attachSwipe` | n/a | ✗ | n/a | Lost on touch browsers. | C (renderer) | P1 | S |
| 18 | Viewer: pinch / zoom image | ✗ | ✅ ZoomableImage | ✗ | ✗ | Android users lose zoom. | C (renderer: reuse ZoomableImage) | P0 | M |
| 19 | Video playback | ✅ | ✅ | ✅ | ✅ | – | – | – | – |
| 20 | Details panel | ✅ full EXIF + mini-map + map link | ◐ 4 fields | ✅ 12 fields | ✅ 12 fields | Shared lacks aperture, shutter, ISO, focal length and orientation (the viewer field limit is 12), the location mini-map and the link. | S: one composed "Exposure" field. C (optional): field `href` | P2 | S |
| 21 | Favorite from a tile, favorite badge | ✅ | ✅ | ✗ viewer or bulk only | ✗ | No heart on tiles, and favorites can't be seen in the grid. | C: a tile badge or quick action (`item.badge`, or one tile action) | P1 | M |
| 22 | Delete from a tile | ✅ trash badge | via selection | via selection or viewer | via selection or viewer | Acceptable difference. | – | – | – |
| 23 | Selection, bulk actions | ✗ | ◐ long-press → delete only | ✅ Favorite, bin, restore, erase | ✅ | Shared is ahead. Missing: select all, bulk unfavorite, add selection to album. Each item is a sequential request. | C (select all); S (optional bulk routes) | P2 | M |
| 24 | Move to Locked Folder (viewer) | ✅ PIN prompt | ✅ PIN / biometric modal | ✗ | ✗ | **Lost.** An action can't ask for an unlock first. | C: an "unlock first" step for an action, provided by a capability (a vault capability from the Locked Folder, the client's own PIN and biometric UI), similar to `pick` | P0 | L |
| 25 | Locked Folder itself (PIN, biometrics, encryption, recovery, move-out) | ✅ (LF page module) | ✅ LockedFolderTab | ✗ | ✗ | Stays native by design; it only needs a way in from the shared interface. | N + client wiring: an entry point to the Locked Folder on both clients | P0 | S–M |
| 26 | Import from a server folder (scan / import) | ✅ | ✗ (empty text wrongly says "Import some from your Albums tab") | ✗ | ✗ | Lost on web. | J: a form with `source` and Scan / Import → existing `scan`/`import` routes. S: add a `message` to their answers. Optional: `file-browser` | P0 | S |
| 27 | Upload, download, share, export | ✗ upload, ✗ download | ◐ Share sends a bare authenticated URL (the recipient can't open it) | ✗ | ✗ | Nothing works well anywhere today. | C: `download`/`share` action (web: authenticated fetch → save; Android: download → share the file) | P1 | M |
| 28 | Phone sync (background, Wi-Fi only, Sync now, permission) | status only (Dev Mode log) | ✅ | ✗ | ✗ | Device-side; registered in `App.tsx`, so it doesn't depend on the Photos screen. | N: reach `PhotoConfigurationScreen` from the shared interface | P0 | S |
| 29 | Settings (source_paths mappings, default sync folder, retention, default import directory) | ✅ tab | ✅ screen | ✗ | ✗ | `source_paths` is a list of objects; the contract's form has no repeatable rows. | N for now (entry point, as #28). C later: repeatable form rows | P0 entry / P2 C | S / M |
| 30 | Offline cache (Android) | n/a | ✅ cached list, "Showing cached photos - offline" | n/a | ✗ (only the document is cached; the notice says "Offline" for any failure) | **Lost.** | C: opt-in per-server page-data cache, forgotten on a Locked Folder move (as `forgetCachedPhoto`) | P0 (Android) | M |
| 31 | Deep link `#/satellite/Photo/LockedFolder` (web) | ✅ | n/a | ✗ | n/a | Breaks if the shared interface becomes the default. | Client wiring with #25 | P0 | S |
| 32 | Large libraries | ◐ every tile in the DOM | ✗ 50k never loaded | ✅ paged | ✅ virtualized | Shared is far ahead. Picker add of N items saves the album file N times. | S (optional): one album save | P2 | S |

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
both clients. M7 to M10 are next.

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

**Should follow soon (they don't block the switch)**
- M7. Favorite heart on tiles (#21).
- M8. Download / share action, which fixes Android Share (#27).
- M9. Web viewer touch swipe (#17).
- M10. Camera grouping and the "All" view (#2).

**Can stay native or Satellite-specific**
- The Locked Folder internals: PIN, biometrics, encryption, recovery, move-out (#25).
- Phone sync and its background task (#28).
- The `source_paths` mappings editor (#29), until repeatable form rows exist.
- The dedicated web's sync listener log (Developer Mode).

**Optional (don't block the switch)**
- Summary and tools note (#5).
- Album group hints (#6).
- Exposure details and map link (#20).
- Map cluster preview (#15).
- Select all, bulk unfavorite, add selection to album, bulk routes (#23).
- Bulk remove from album (#10).
- One album save per pick (#32).
- Repeatable form rows (#29).
