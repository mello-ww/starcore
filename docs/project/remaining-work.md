# Remaining work: every Satellite on the shared interface (2026-11-12, at 9c79049)

This is the one list of what is left to do. The detailed audits it draws on stay where they
are: [`file-explorer-migration.md`](../archive/file-explorer-migration.md) (File Explorer's matrix and
contract specs), [`photos-parity-audit.md`](../archive/photos-parity-audit.md) (Photos' matrix, by `#`
number) and [`media-audio.md`](../reference/media-audio.md) (the audio host). When an item here is done,
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
| Photos | ✅ its only interface on both clients (1.2) | none: `page.js` and `src/photo/` removed (P3) |
| File Explorer | ✅ its shared interface alone on both clients (F1-F7): browsing, a file's page (open, download, share), management (new folder, rename, delete) and upload | none: its `page.js` and `page.css` are removed |
| Music | ✅ its only interface on both clients (1.2, A1-A10): home, search, Your Library, album, artist, playlist, mix, radio and track pages, settings, stats, offline downloads, through the shared audio host | none: its `page.js` and `mobile/src/music/` are removed (A10) |
| Locked Folder | ✅ its only interface on both clients (1.2, L0-L8): browsing, moves, setup, settings, a forgotten PIN; biometric unlock from the Android app's unlock card | none: its `page.js` and `mobile/src/lockedFolder/` are removed |
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

From [`file-explorer-migration.md`](../archive/file-explorer-migration.md). F1 is done.

- [x] **F2 - List paging:** `more` on `list` in the contract (Engine, both clients, fixtures);
  `view/folder` with `part`, `cursor` and `limit`; tested on 10,000 entries.
- [x] **F2b - Virtualized lists on Android:** a page with a paged list among its own blocks is
  one virtualized list (`VirtualListPage`), its lists' rows one by one, each list loading its
  next page as its end nears; 10,000 files flung through on the emulator with no page failing
  and the JavaScript thread idle afterwards (2026-11-14).
- [x] **Unify the web's paging:** the media-grid now pages through `ui/listpaging.js`, the
  same helper as the list (cursor, stale-page token, refresh depth, duplicate guard); the grid
  keeps only its tiles, selection and viewer.
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

From [`photos-parity-audit.md`](../archive/photos-parity-audit.md), which holds the inventory of the old
phone sync, the design of the new one and each milestone's files and tests (plan approved by
the owner 2026-11-15).

- [ ] **Phone sync (#28):** the old sync is removed whole, then a real automatic backup is
  built as a generic capability (`media.sync` from a Satellite, `device.media-sync` in the app).
  - [x] **S0** - remove the old sync: the standalone listener, `sync_upload`, the `sync_*`
    settings, the app's background task, its tests and docs.
  - [x] **S1** - `media.sync` v1 in Photo: `check`, a resumable `upload` streamed to disk,
    `status`, `devices`; the Engine's device credential.
  - [x] **S2** - the `sync` action (contract change 4); Photo's button and Devices page.
  - [x] **S3** - the app's sync: WorkManager, MediaStore detection, the local index, folders,
    Wi-Fi and charging rules, progress and errors. `App.tsx` no longer imports `src/photo/`.
  - [ ] **S4** - emulator runs (done, with three fixes: see the audit's "What S4 found"), then
    the owner's phone: the "real phone only" row of the audit's test table.
  - [x] **S5** - security review: one medium finding fixed (a protected store that can't
    answer no longer makes a phone's files "known"), three smaller ones, and what is accepted
    (the audit's "Security review of S1 to S4").
- [x] **P1 - Settings (#29):** the `source_paths` mappings as repeatable form rows (the `rows`
  field kind arrives with contract change 2, in the Locked Folder's L4); the `own: "settings"`
  entry goes. Phone sync was reached from Settings with `{"own": "sync"}` until S0 removed it.
- [x] **The Locked Folder (#37):** stage 4.
- [x] **P2 - Icons shipped by the Satellite (#38):** a declared `icons/` folder, validated by
  the Engine (single colour, no script) and served as path data, drawn by both clients with a
  shared icon as fallback (contract change 5). Every Satellite's `mission_control/icon.svg`
  became `icons/logo.svg`; Photo's Albums tab has its own icon.
- [x] **P3** - removed `satellites/native/photo/mission_control/page.js` and `page.css`,
  `mobile/src/photo/` (with its tests), its routes in `MainTabs.tsx` and its `DEDICATED_SCREENS`
  entry. The Satellite publishes no page of its own; `KNOWN_IMPORTS` lost `MainTabs.tsx` and
  `KNOWN_COUPLINGS` its Photo count.
- [x] Optional, from the audit: the summary's tools note (#5), the bin as a tile and album
  group hints (#6), bulk remove from an album (#10), map cluster preview (#15), exposure details
  and map link (#20), select all and bulk unfavorite (#23), one album save per pick (#32).
  Contract change 15: a viewer field's `href`, a map's `viewport.preview`. Left out, still
  optional: adding a selection to an album (a selection can't `choose`, and the library's
  selection has its 4 actions), bulk routes (each selected item is still one request), and
  orientation among the details (thumbnails are already turned upright).

## 4. The Locked Folder through `media.vault` (R3)

Its security audit is done (2026-11-15): findings by severity, the design and each milestone's
files and tests are in [`satellites/locked_folder.md`](../satellites/locked_folder.md), "Security
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
- [x] **L5** - end to end on the local demo; the owner validated it on the web and the phone
  (2026-11-16, `docs/satellites/locked_folder.md`, "End to end on the local demo").
- [x] **L5 finding - a forgotten PIN in the shared interface** (contract change 3): a protected
  document may name a `forgot` page, which the unlock card's "Forgot your PIN?" opens in its
  place; the Locked Folder's offers the recovery key, or says what else can be done.
- [x] **L6** - the vault and the library move files through capabilities: `media.vault`'s
  `sealed` and `media.gallery`'s `original`, `release` and `adopt`, for the server alone
  (a request through the Engine carries its `caller`). `KNOWN_CROSS_SATELLITE` lost the vault's
  and `private_media.py`'s entries.
- [x] **L7** - security review of L0 to L6 (`docs/satellites/locked_folder.md`, "Security review
  of L0 to L6"). Fixed: on a Windows server another name for the vault's folder
  (`\\?\C:\...`, the drive's loopback share) got past `files.protected`, which now tells the
  vault by its identity on disk; on Android the viewer and the secret prompts, drawn in Modals,
  could be captured, and now set `FLAG_SECURE` on their own windows; `check` answered clients,
  and now answers the server alone. Accepted and documented: an unreadable `sealed.json` reads
  as empty.
- [x] **L7 follow-up - the phone check** (with L5's): a screenshot of the vault's viewer, of a
  PIN prompt and of the recovery-key dialog comes out black. The owner validated the phone side
  on the emulator with this build (2026-11-16).
- [x] **L7 follow-up - a browser's cache after a move in:** Mission Control asks the browser to
  fetch a moved item's thumbnail and original again (`cache: "reload"`), which replaces the copies
  it cached (the Android app already evicts its image cache).
- [x] **L8** - removed the Locked Folder's `page.js` and `mobile/src/lockedFolder/`, Photo's
  Locked Folder tab and its own Lock move on both clients (2026-11-16). Turning biometric unlock
  on and off, which only the old Android screens did, moved to the app's unlock card.

What those milestones cover, as first listed:

- [x] **Browse, view and move out** from the shared interface while unlocked, through
  `media.vault` operations that answer only with a grant, never a listing without one.
- [x] **Its management:** setting and changing the PIN, the location, turning encryption on
  (the recovery key shown once), recovering with that key, deleting the backup, biometric
  devices. Secrets are typed and shown only in client-owned prompts, so the contract needs a
  prompt for setting a secret and one for showing a secret once.
- [x] **The unlock prompt as generic app code:** from `mobile/src/lockedFolder/` to an
  implementation of the `media.vault` protocol (for example `mobile/src/vault/`).
- [x] **Sections discovered from the catalog,** so Photo no longer names the Locked Folder
  (in its `page.js`, which hosts it today, in `gallery.py`'s tile and in its `ui.json`
  labels, which would then come from the provider).
- [x] **Between Satellites:** Photo's `private_media.py` and the vault's `vault.py` reach each
  other through capabilities (File Explorer's guard already did, in L1: it is now
  `protection.py`, over `files.protected`). Their comments naming each other go with them.
- [x] Then remove the Locked Folder's `page.js` and `mobile/src/lockedFolder/`.

Its audit and plan go in [`satellites/locked_folder.md`](../satellites/locked_folder.md).

## 5. Music on `ui.json` (R4)

The largest piece. Its own audit comes first, as for Photos: a parity matrix of the web views
and the Android screens against what the contract can draw.

- [x] **The audit and plan,** in [`media-audio.md`](../reference/media-audio.md), "Music on the shared
  interface": a 42-row parity matrix, contract changes 6 to 10 and milestones A1 to A10.
  Written and approved by the owner on 2026-11-18.
- [x] **Library pages, A1:** `play` with `tracks` or `route` (change 6), and Music's first
  `ui.json` (a preview): album, artist, mix, radio, mood, genre and track pages, the cover
  mosaic and the genre page.
- [x] **Library pages, A2:** home (Daily Mixes, recents), Your Library, search and folders, as
  media lists and grids that play through the audio host (change 7), with change 6's paged
  queue and lazy shuffle for the long lists. Rows and tiles have menus and hearts, shelves
  scroll sideways, and going back restores the scroll position and loaded pages.
- [x] **Playlists** (A3): create, rename, cover, reorder, add and remove tracks, smart rules,
  M3U import and export (change 8): `choose` for Add to playlist, a `media-list`'s `reorder`.
- [x] **The player's additions declared by the document** (A4): its track menu, Add to
  playlist and the links to an album or artist (change 9: `audio`, `reloads`, `follows`).
  `MUSIC_AUDIO_EXTENSIONS` and `setExtensions` stayed for the own interface until A10.
- [x] **Settings and equalizer** as forms (A5): Settings, Equalizer, Scan and Duplicates.
- [x] **Stats and Wrapped** as dashboard pages (A6).
- [x] **Offline downloads** as a generic client capability (keep a provider's tracks on the
  device), with its Downloads page (A7, change 10).
- [x] **The web player's keyboard shortcuts** active wherever the host plays, not only on
  Music's page (A8; `mission_control/media/keys.js` looks for `.pl-root`).
- [x] **End to end, then the default** (A9): the isolated demo on both clients, a short
  review, `preview` removed, the owner's validation (2026-11-26).
- [x] **Music's own interface removed** (A10): its `page.js`, `page.css`, `views/`, `ui/`,
  `mobile/src/music/`, `builtins.tsx` and `DEDICATED_SCREENS`. The guard's lists are all empty:
  `SATELLITE_SPECIFIC`, `KNOWN_COUPLINGS`, `KNOWN_IMPORTS` and `KNOWN_CROSS_SATELLITE`.

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
contract changes five times in all, each time in the Engine, both clients, the documents and
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
| 10 | S2 | change 4: the `sync` action | Opus 5.5 high |
| 11 | S3, S4 | none (the app's sync, then devices) | Opus 5.5 xhigh, then high |
| 12 | S5 | none (security review) | Fable 5.2 high |
| 13 | P2 | change 5: Satellite icons | Opus 5.5 high |
| 14 | P3 | none (removal) | Sonnet 5.5 medium |

The sync (8 to 12) depends on nothing in the Locked Folder's milestones except L1's check for
protected media; it can run before them if the phone's backup matters more.

**Method:** one piece at a time. Each piece starts with a plan in the existing docs (no new
files), which the owner approves before any code. Then small milestones, one commit each,
tested on both clients (automated tests, the web and the emulator), each followed by a short
summary to the owner. An old interface goes only after the owner has validated its
replacement on the web and on the phone. Tick the boxes here as items are done.

## 7. The owner's review of 2026-11-26

What the owner found when trying the shared interfaces. The rule for each item: what is
generic (the contract, `mission_control/ui/`, `mobile/src/satellites/ui/`, `mobile/src/components/`)
names no Satellite; what belongs to one Satellite (its `ui.json`, its Engine code, its icons) stays
in that Satellite's folder. "Shared" below means the first, "own" the second. Order: the shared
mechanisms first, since several Satellites use them, then each Satellite's items.

**Shared mechanisms (one change serves several items)**

- [x] **Page width.** On a 1080p screen the web interface stopped at about two thirds of the
      page. Every shared page now uses the whole view, whatever its template (the 880 px
      reading width and the 1400 px cap on every view are gone).
- [x] **Accent colour** on the shared controls that still lack it (selected and active states),
      on both clients: the breadcrumb's current place, a focused field's frame, caret and
      selection (the app's shared `StarInput`), and a selected option's label on a custom
      accent.
- [x] **A header row of actions, each with its own drop-down.** Every action of the page sits
      on one line above the content, instead of a column. An action that needs a text field or
      buttons (a name, a choice) opens a drop-down under the button that was pressed, holding
      them. Done as contract change 11 (the `actions` and `dropdown` blocks), on both clients,
      used by File Explorer and Photos below.
- [x] **A viewer hides the floating player.** While a photo (any media viewer) is full screen,
      the floating player slides down out of the way, with a restrained animation that respects
      reduced motion, and comes back after. Both clients, in the shared player and viewer: on
      the web while `body.ui-viewer-open` is set (the viewer and the pickers), on Android
      while a `MediaViewer` holds the player aside (`holdPlayerAside` in `media/ui/dock.ts`).
- [x] **Animations on Android**, where they help: a sliding selector when a pill tab changes
      (`PillTabs`), and similar transitions in the shared components. Reduced-motion aware.
      Done in `mobile/src/components/motion.tsx`: `useSlidingSelection` slides an accent pill
      behind the selected option (its position on the native driver, so a page loading at the
      same moment cannot stall it) for `PillTabs`, a document's page tabs, the `choice` block's
      segments and a form's `select` options; a row drawn again for the new selection passes
      `remember` and slides from where its accent last came to rest. `Reveal` fades a
      drop-down's panel in. `useReducedMotion` is shared (the floating player and the media
      grid use it too); under reduced motion everything moves without animating.
- [x] **Swiping between the app's main tabs** (home, Satellites, console, settings, and config
      when Developer Mode is on) on Android. A one-finger sideways swipe that nothing inside
      the screen took (`navigation/tabSwipe.ts`) opens the neighbouring tab, without wrapping.
      The tabs are pages side by side that the swipe drags with the finger, as a launcher's
      home screens (`navigation/PagerTabs.tsx`); Mission Control slides a page opened from its
      sidebar in from the side it lies on.

**File Explorer (own, unless noted)**

- [x] Readable type names for the well-known extensions (`.exe` is a Windows application, and
      so on), in the Satellite's Engine code and shown as file metadata. Done in its
      `views.py` (`KINDS`), shown as the file page's Type; any other extension stays "XYZ file".
- [x] Its header actions (new folder, this folder, upload, up) on one line, those that need a
      field opening their own drop-down (above); a file's page too (open, download, share,
      and Manage for the rename and delete).
- [x] "All locations" is called "Up" too when the folder is a drive's root.
- [x] A graceful error when the server refuses a change for lack of permission (create,
      rename, delete, upload), checked on both clients. Done in its `api.py` (`_refused`): a 403
      whose sentence names the place ("StarCore isn't allowed to create a folder in 'X'. Its
      account on the server needs permission there."), shown as each client's error toast; on
      Mission Control the toast now rises above the floating player and wraps.
- [x] On the web only (Mission Control): drop the back button beside the folder name, since
      "up" exists. Done with the page key `back: false` (contract change 12).

**Music (own, unless noted)**

- [x] The overlay hides while a viewer is open (shared, above).
- [x] Its sidebar on Mission Control, as its own page had: a document picks `layout: "sidebar"`
      or the default `"tabs"` (contract change 13), both kept as templates for every
      Satellite. File Explorer and Photos keep the tabs.
- [x] A check-up of the settings that are listed but not programmed yet. Every setting on
      the Settings page was traced to the code that reads it. Two did nothing and now work:
      "Transcodes at once" (`transcode_workers`, never handed to the transcoder) and the
      Appearance density on Mission Control (`theme.js` set the wrong attribute). The server
      and Mission Control read all the others. The Android app still ignores a few, listed
      next.
- [x] Music's playback settings the Android app did not apply. Normalize volume now runs on
      the app's audio session (`DynamicsProcessing`, Android 9 and later, with Mission
      Control's compressor and limiter settings), and the accent colours the floating player
      and the full player (StarCore's, a colour of one's own, or the cover's, sampled by
      Mission Control's rule in `media/ArtworkPalette.kt`). Crossfade and the player theme,
      density and visualizer stay Mission Control's: the page hides them on Android through a
      block's `requires` (contract change 14) and the client capabilities `media.audio-crossfade`,
      `-theme`, `-density` and `-visualizer`, which only Mission Control claims. Gapless
      playback now runs on Android too (`media.audio-gapless`): the AudioHost keeps a second
      player that loads the next track, paused, 25 seconds before the end and starts it the
      moment the current one ends.
      Checking it found an older fault, now fixed: an Android form kept the values of its
      first drawing, before the page's data came, so a select showed no choice and a saved one
      seemed lost. A form now follows its data until the person changes something in it.
- [x] Search: a grey bar under the search field. No longer seen after the earlier changes
      (checked on the web and the Android emulator); the owner confirmed it is gone.

**Photos**

- [x] The album page's buttons on one line, "Create album" opening its own drop-down with the
      name field (above); an album's own page too (Add photos, and Album for the rename and
      delete).

**Status**

- [x] Rebuild the old interface's graphs on the shared interface (the `chart` block exists since
      1.1; add what is missing to the contract if needed), and check it on the Android app too.
      Nothing was missing from the contract: the overview's tiles carry a meter and a trend, and
      every chart of the old page is a `chart` block with its "Show values" table. Checking it
      found the interface rejected since the Satellite icons (its document still said 1.1, so
      neither client showed it) and the tiles' meters drawn zero wide on Mission Control; both
      are fixed, and a test now loads every shipped `ui.json` with its manifest's icons.

## 8. Open with, Show in folder (asked on 2026-11-27)

Linking Satellites without coupling them: File Explorer's file page lists what can open a
file ("Opens with"), Photos opens images and videos, Music plays sounds (directly when they
are outside its library, and they can still go in a playlist), and Photos and Music show an
item's file in File Explorer. The audit and the plan: [`open-with-audit.md`](../archive/open-with-audit.md).

- [x] O1 contract change 16: the `files.open` capability (types, extensions, label), the
      `openers` block and the `locate` action (Show in folder; `reveal` was taken), on the
      Engine, the vocabulary, the fixtures and both clients.
- [x] O2 File Explorer: `stat` and `locate`, "Opens with" on the file page.
- [x] O3 Photos: open by path, its page for a file outside the library, Show in folder.
- [x] O4 Music: open by path, external tracks (direct playback, playlists), Show in folder.
- [x] O5 security review of O1 to O4: a protected area open for the session is never kept by
      Music nor taken into Photos' library, a track's path that comes to lead elsewhere is missing,
      lyrics beside an outside sound are checked, its transcodes and the browser's copy go with it.
- [x] O6 runs on the web demo and the emulator, docs, a new APK: the Android screen now
      fetches the Satellites for an opener or a locate, and a portrait picture fits its frame on
      the web. Then contract change 17: a list item's `selected`, so the folder page marks and
      scrolls to the file Show in folder points at.
- [x] File Explorer names media types the way a desktop file manager does ("MP4 video",
      "M4A audio", "BMP image"), and a long field value (a folder's path) takes a line of its
      own on both clients instead of wrapping in a narrow column and pushing the other values
      down.

## Outside this migration

Tracked in [`roadmap.md`](roadmap.md), not here: what has not been verified (the Python tests
skipped on Windows, a physical phone, the production HTTPS proxy), and the features still to build. The light theme on Android is not
part of the stable release.
