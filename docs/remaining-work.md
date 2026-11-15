# Remaining work: every Satellite on the shared interface (2026-11-12, at 9c79049)

This is the one list of what is left to do. The detailed audits it draws on stay where they
are: [`file-explorer-migration.md`](file-explorer-migration.md) (File Explorer's matrix and
contract specs), [`photos-parity-audit.md`](photos-parity-audit.md) (Photos' matrix, by `#`
number) and [`media-audio.md`](media-audio.md) (the audio host). When an item here is done,
tick it here.

## The goal

Adding or changing a Satellite needs no change to the Engine, Mission Control or the Android
app. A Satellite carries everything it needs (its `ui.json`, routes, capabilities, icons); no
code outside a Satellite's folder is written for one Satellite, and no comment there names one.
Clients implement the UI contract and capability protocols, never a Satellite.

**Done means:**
- `engine/tests/test_client_modularity.py` has empty `KNOWN_COUPLINGS`, `KNOWN_IMPORTS` and
  `KNOWN_CROSS_SATELLITE`, and `SATELLITE_SPECIFIC` lists no folder.
- Every first-party Satellite opens its `ui.json` on both clients, and none ships a
  `mission_control/page.js` (the mechanism stays, documented as a web extension).
- The leftovers the guard can't see (stage 6) are gone too.

## How we work, until further notice

- **No backward compatibility.** StarCore is deployed only on the owner's server, kept on the
  latest version, with the latest app. Nothing is kept only for older servers, older apps or
  the released Alpha (0.1.0-alpha.1). Contract versions stay as labels; a contract change may
  break older documents if every `ui.json`, both clients and the shared fixtures change together.
- **Parity, then removal.** A Satellite's own interface goes once its shared one does
  everything it did and the owner has validated it, on the web and on the phone. No extra
  release in Developer Mode.
- **Contract features stay generic.** Anything a Satellite needs from the clients is a block,
  an action or a capability any Satellite could use.

## Where each Satellite stands

| Satellite | Shared interface | Own code still used |
|---|---|---|
| Status | ✅ its only interface on both clients (1.1) | none |
| Photos | ✅ default on both clients (1.2) | web `page.js` for settings and the Locked Folder; Android `src/photo/` for settings, phone sync and the Locked Folder; background sync started by `App.tsx` |
| File Explorer | ✅ its shared interface alone on both clients (F1-F7): browsing, a file's page (open, download, share), management (new folder, rename, delete) and upload | none: its `page.js` and `page.css` are removed |
| Music | ◐ only the player: the shared audio host on both clients, and `play` for any Satellite. No `ui.json` | web `page.js` with its views (home, library, album, artist, playlist, search, settings, stats); Android `src/music/` (11 screen and tab files), wired by `builtins.tsx` |
| Locked Folder | ◐ only moving photos in, from Photos (`secure` + `media.vault`) | web `page.js` (about 1,200 lines: browsing, PIN, encryption, recovery), hosted by Photo's page; Android `src/lockedFolder/` (its screens and the unlock prompt) |
| Docker | – a placeholder with no interface | none |

Music was the first Satellite to be redesigned and the first to give the shared system
something: its player became the audio host and the `audio.library` capability (2026-11-04).
Its library screens were never moved, which is why it is the largest piece left.

## 1. Drop what only older servers and the Alpha needed

Small and independent; unblocked by the no-compatibility rule.

- [x] Status's previous interface: its `page.js`, `mobile/src/status/`, the Home card, the
  `StatusHome` route, `DEDICATED_SCREENS`' Status entry and the `KNOWN_*` lines.
- [x] The fallback icons for servers before UI contract 1.0 (`mobile/src/satellites/icons.ts`'s
  name list); every Satellite declares `icon_name`.
- [x] The v0 `mobile` route: Music's, Photo's and Status's `mobile` routes, the Engine's
  `mobile_ui` field, the app's `DeclarativeScreen` and `SatelliteDetailScreen`, their tests.
- [x] The audio host's `fallbackProvider` and `MUSIC_LEGACY_PROVIDER` (servers without the
  `audio.library` capability).
- [x] The app's other checks for an old Engine (the About card's "older Engine" wording, the
  "absent on servers older than 1.0" notes). The optional typing of `ui`, `icon_name` and
  `provides` stays: harmless, and several tests build Satellites without them.
- [x] Docs: the "Backward compatibility" part of `ui-contract.md` and `media-audio.md`'s
  "Compatibility". Status's Alpha notes go with its interface (next item).

## 2. File Explorer (R1)

From [`file-explorer-migration.md`](file-explorer-migration.md). F1 is done.

- [x] **F2 - List paging:** `more` on `list` in the contract (Engine, both clients, fixtures);
  `view/folder` with `part`, `cursor` and `limit`; tested on 10,000 entries.
- [x] **F2b - Virtualized lists on Android:** a page with a paged list among its own blocks is
  one virtualized list (`VirtualListPage`), its lists' rows one by one, each list loading its
  next page as its end nears; 10,000 files flung through on the emulator with no page failing
  and the JavaScript thread idle afterwards (2026-11-14).
- [ ] **Unify the web's paging:** the media-grid and the list each keep their own paging code
  on the web (`ui/gallery.js`, `ui/listpaging.js`); one shared helper, once both are stable.
- [x] **F3 - File page:** details, picture preview, Download, Share, and Open (`download` with
  `open: true`: a new tab on the web, the system viewer on Android through
  `StarCoreFilesModule.kt`); an HTML, SVG or XML file opened in a tab is sandboxed.
- [x] **F4 - Management:** new folder, rename, delete, through forms and confirms; the Locked
  Folder's guard still refuses.
- [x] **F5 - Upload:** the `upload` action on both clients (pick files, stream them, confirm a
  replacement on `409`, report each file).
- [x] **F6 - Default:** drop `preview`; `docs/satellites/file_explorer.md`; CHANGELOG.
- [x] **F7 - Remove** `page.js` and `page.css`.
- [x] Decided: the storage themes (classic, bar, donut, orbital) went with `page.js`
  (recommended), or become a shared block.
- [x] A clickable breadcrumb: the new `breadcrumb` block (UI contract 1.2), on one scrolling row; the folder page's
  path is drawn with it on both clients.

## 3. Photos without its own interface (R2)

From [`photos-parity-audit.md`](photos-parity-audit.md), which holds the inventory of the old
phone sync, the design of the new one and each milestone's files and tests (plan approved by
the owner 2026-11-15).

- [ ] **Phone sync (#28):** the old sync is removed whole, then a real automatic backup is
  built as a generic capability (`media.sync` from a Satellite, `device.media-sync` in the app).
  - [ ] **S0** - remove the old sync: the standalone listener, `sync_upload`, the `sync_*`
    settings, the app's background task, its tests and docs.
  - [ ] **S1** - `media.sync` v1 in Photo: `check`, a resumable `upload` streamed to disk,
    `status`, `devices`; the Engine's device credential.
  - [ ] **S2** - the `sync` action (contract change 3); Photo's button and Devices page.
  - [ ] **S3** - the app's sync: WorkManager, MediaStore detection, the local index, folders,
    Wi-Fi and charging rules, progress and errors. `App.tsx` no longer imports `src/photo/`.
  - [ ] **S4** - emulator runs, then the owner's phone.
  - [ ] **S5** - security review.
- [x] **P1 - Settings (#29):** the `source_paths` mappings as repeatable form rows (the `rows`
  field kind arrives with contract change 2, in the Locked Folder's L4); the `own: "settings"`
  entry goes. Phone sync is reached from Settings with `{"own": "sync"}` until S0 to S4
  replace it.
- [ ] **The Locked Folder (#37):** stage 4.
- [ ] **P2 - Icons shipped by the Satellite (#38):** a declared `icons/` folder, validated by
  the Engine (single colour, no script), drawn by both clients with a shared icon as fallback
  (contract change 4).
- [ ] **P3** - then remove `satellites/native/photo/mission_control/page.js` and `page.css`,
  `mobile/src/photo/`, its routes in `MainTabs.tsx` and its `DEDICATED_SCREENS` entry.
- [ ] Optional, from the audit: the summary's tools note (#5), album group hints (#6), bulk
  remove from an album (#10), map cluster preview (#15), exposure details and map link (#20),
  select all and bulk routes (#23), one album save per pick (#32).

## 4. The Locked Folder through `media.vault` (R3)

Its security audit is done (2026-11-15): findings by severity, the design and each milestone's
files and tests are in [`satellites/locked_folder.md`](satellites/locked_folder.md), "Security
audit and plan". The owner approved the plan on 2026-11-15. The audit found one
high-severity gap: disabling the Locked Folder Satellite removed File Explorer's guard. L0
closed it.

- [x] **L0** - that gap closed; `status` and the settings without the vault's path while
  locked; the unlock table under its lock; after a reload the guard follows the rebuilt
  Satellite.
- [x] **L1** - `files.protected`: one Engine check every Satellite that takes a path asks
  (File Explorer, Photo, Music).
- [x] **L2** - protected documents, the `section` action, an unlock that ends when idle, the
  generic unlock prompt on both clients (contract change 1).
- [x] **L3** - the Locked Folder's own `ui.json`: browse, view, move out, delete, upload, a
  preview behind its own page and screens; Photo lists the Satellites it hosts as tiles.
- [x] **L4** - client-owned prompts for typing and showing secrets, and repeatable form rows
  (contract change 2); the vault's settings and setup pages. Biometric enrolment stays in the
  app's own screens for now.
- [ ] **L5** - end to end on the local demo; the owner validates on the web and the phone. Run
  on the web (2026-11-15, `docs/satellites/locked_folder.md`, "End to end on the local demo");
  the emulator went offline, so the app's side waits for the owner's phone check.
- [ ] **L5 finding - a forgotten PIN in the shared interface:** the own page's locked screen
  offers "Forgot your PIN?" (the recovery-key form); the shared document's unlock card offers
  only Unlock. The protected document needs a way out of the unlock card (a contract change)
  before L8.
- [x] **L6** - the vault and the library move files through capabilities: `media.vault`'s
  `sealed` and `media.gallery`'s `original`, `release` and `adopt`, for the server alone
  (a request through the Engine carries its `caller`). `KNOWN_CROSS_SATELLITE` lost the vault's
  and `private_media.py`'s entries; Photo's `page.js` (the Locked Folder tab) stays until L8.
- [x] **L7** - security review of L0 to L6 (`docs/satellites/locked_folder.md`, "Security review
  of L0 to L6"). Fixed: on a Windows server another name for the vault's folder
  (`\\?\C:\...`, the drive's loopback share) got past `files.protected`, which now tells the
  vault by its identity on disk; on Android the viewer and the secret prompts, drawn in Modals,
  could be captured, and now set `FLAG_SECURE` on their own windows; `check` answered clients,
  and now answers the server alone. Accepted and documented: an unreadable `sealed.json` reads
  as empty.
- [ ] **L7 follow-up - the phone check** (with L5's): a screenshot of the vault's viewer, of a
  PIN prompt and of the recovery-key dialog comes out black. The fix is built but was not seen
  on a device.
- [ ] **L7 follow-up - a browser's cache after a move in:** Mission Control asks the browser to
  fetch a moved item's thumbnail and original again, which replaces the copies it cached (the
  Android app already evicts its image cache).
- [ ] **L8** - remove the Locked Folder's `page.js` and `mobile/src/lockedFolder/`.

What those milestones cover, as first listed:

- [ ] **Browse, view and move out** from the shared interface while unlocked, through
  `media.vault` operations that answer only with a grant, never a listing without one.
- [ ] **Its management:** setting and changing the PIN, the location, turning encryption on
  (the recovery key shown once), recovering with that key, deleting the backup, biometric
  devices. Secrets are typed and shown only in client-owned prompts, so the contract needs a
  prompt for setting a secret and one for showing a secret once.
- [ ] **The unlock prompt as generic app code:** from `mobile/src/lockedFolder/` to an
  implementation of the `media.vault` protocol (for example `mobile/src/vault/`).
- [ ] **Sections discovered from the catalog,** so Photo no longer names the Locked Folder
  (in its `page.js`, which hosts it today, in `gallery.py`'s tile and in its `ui.json`
  labels, which would then come from the provider).
- [ ] **Between Satellites:** Photo's `private_media.py` and the vault's `vault.py` reach each
  other through capabilities (File Explorer's guard already did, in L1: it is now
  `protection.py`, over `files.protected`). Their comments naming each other go with them.
- [ ] Then remove the Locked Folder's `page.js` and `mobile/src/lockedFolder/`.

Its audit and plan go in [`satellites/locked_folder.md`](satellites/locked_folder.md).

## 5. Music on `ui.json` (R4)

The largest piece. Its own audit comes first, as for Photos: a parity matrix of the web views
and the Android screens against what the contract can draw.

- [ ] **The audit and plan,** in [`media-audio.md`](media-audio.md).
- [ ] **Library pages:** home (Daily Mixes, recents), library, albums, artists, playlists,
  tracks, search, as media lists and grids that play through the audio host.
- [ ] **Playlists:** create, rename, reorder, add and remove tracks, M3U import and export.
- [ ] **Settings and equalizer** as forms; **stats and Wrapped** as dashboard pages.
- [ ] **Offline downloads** as a generic client capability (keep a provider's tracks on the
  device), with its Downloads page.
- [ ] **The player's additions declared by the document:** its track menu, Add to playlist and
  the links to an album or artist, instead of `MUSIC_AUDIO_EXTENSIONS` and `setExtensions`.
- [ ] **The web player's keyboard shortcuts** active wherever the host plays, not only on
  Music's page (`mission_control/media/keys.js` looks for `.pl-root`).
- [ ] Then remove Music's `page.js`, `page.css`, `views/`, `ui/`, `mobile/src/music/`,
  `builtins.tsx`'s Music entries and its `DEDICATED_SCREENS` entry; `builtins.tsx` goes when
  empty.

## 6. Leftovers the guard can't see

`test_client_modularity.py` checks Satellite names as string literals and object keys in the
clients' code, and every comment of shared code (the Engine, Mission Control, the app outside
its Satellite-specific folders, its Kotlin and manifest). It does not check identifiers or
user-facing text.

- [x] **Neutral player wording:** the web bar's "Music player" label, "Open StarCore Music on
  your phone", the Android Devices panel's "Music streams…".
- [x] **Neutral names in the audio hosts:** `MusicPreferences` is `PlaybackPreferences`,
  `musicKeys` is `playerKeys`, the test IDs are `player-disc`, `player-mini`, `player-retract`
  and `player-video`.
- [x] **Stored keys** renamed to `starcore.player.*` (web) and `starcore_player_*` (Android):
  the saved queue and the Connect device id were reset once. The offline downloads keep
  `starcore_music_downloads` and the `files/music/` folder, so the copies on the phone survive.
- [x] **The Kotlin package** `com.starcore.mobile.music` renamed to `media` (`MusicPackage` is
  `MediaPackage`); `:app:compileDebugKotlin` builds with JDK 17.
- [x] **The web player's CSS prefix** `mu-` is now `pl-` (`.pl-bar`, `--pl-*`, `data-pl-theme`), in the
  player and in Music's page styles that share it.
- [x] **The guard's code check extended to the Engine**: `engine/starcore/**/*.py` names no
  Satellite in a literal or key, with no exception list (the CLI's column is "State" and its
  help examples use `<name>`).

## Order (validated by the owner on 2026-11-13)

1. Stages 1 and 6: the cleanup, small and safe, so there is less code to carry.
2. File Explorer (2): done (F1-F7); its paging, upload and open serve Music and the Locked Folder.
3. The Locked Folder (4): a security audit first. It unblocks the end of Photos.
4. Photos (3): settings, phone sync and icons, then its own interface goes.
5. Music (5): the largest, last, reusing everything built before. An audit first.
6. Stabilisation before the stable release: the bugs, security points and checks listed in
   [`roadmap.md`](roadmap.md) (not the light theme, which waits until after it).

**Stages 3 and 4 together (approved by the owner 2026-11-15; L0 is done).** The
contract changes four times in all, each time in the Engine, both clients, the documents and
the fixtures together:

| Order | Milestones | Contract | Model and effort |
|---|---|---|---|
| 1 | L0, L1 | vocabulary only (`files.protected`) | Opus 5.5 high |
| 2 | L2 | change 1: `protected`, `section`, `keep` | Opus 5.5 xhigh |
| 3 | L3 | none (the Locked Folder's `ui.json`) | Opus 5.5 high |
| 4 | L4, then P1 | change 2: `secrets`, `reveal`, form `rows` | Opus 5.5 xhigh, then high |
| 5 | L5, L6 | vocabulary only (optional operations) | Opus 5.5 high, then xhigh |
| 6 | L7 | none (security review) | Fable 5.2 high |
| 7 | L8 | none (removal) | Sonnet 5.5 medium |
| 8 | S0 | none (removal) | Sonnet 5.5 high |
| 9 | S1 | vocabulary only (`media.sync`) | Opus 5.5 xhigh |
| 10 | S2 | change 3: the `sync` action | Opus 5.5 high |
| 11 | S3, S4 | none (the app's sync, then devices) | Opus 5.5 xhigh, then high |
| 12 | S5 | none (security review) | Fable 5.2 high |
| 13 | P2 | change 4: Satellite icons | Opus 5.5 high |
| 14 | P3 | none (removal) | Sonnet 5.5 medium |

The sync (8 to 12) depends on nothing in the Locked Folder's milestones except L1's check for
protected media; it can run before them if the phone's backup matters more.

**Method:** one piece at a time. Each piece starts with a plan in the existing docs (no new
files), which the owner approves before any code. Then small milestones, one commit each,
tested on both clients (automated tests, the web and the emulator), each followed by a short
summary to the owner. An old interface goes only after the owner has validated its
replacement on the web and on the phone. Tick the boxes here as items are done.

## Outside this migration

Tracked in [`roadmap.md`](roadmap.md), not here: what has not been verified (the Python tests
skipped on Windows, a physical phone, the production HTTPS proxy), the Android lock-screen
position after a pause, and the features still to build. The light theme on Android is not
part of the stable release.
