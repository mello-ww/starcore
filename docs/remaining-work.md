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
| Status | ✅ default on both clients (1.1) | web `page.js` (fallback); Android `src/status/` and the Home card, for servers older than its `ui.json` |
| Photos | ✅ default on both clients (1.2) | web `page.js` for settings and the Locked Folder; Android `src/photo/` for settings, phone sync and the Locked Folder; background sync started by `App.tsx` |
| File Explorer | ◐ read-only preview (F1): Android opens it, the web keeps `page.js` | web `page.js` and `page.css` |
| Music | ◐ only the player: the shared audio host on both clients, and `play` for any Satellite. No `ui.json` | web `page.js` with its views (home, library, album, artist, playlist, search, settings, stats); Android `src/music/` (11 screen and tab files), wired by `builtins.tsx` |
| Locked Folder | ◐ only moving photos in, from Photos (`secure` + `media.vault`) | web `page.js` (about 1,200 lines: browsing, PIN, encryption, recovery), hosted by Photo's page; Android `src/lockedFolder/` (its screens and the unlock prompt) |
| Docker | – a placeholder with no interface | none |

Music was the first Satellite to be redesigned and the first to give the shared system
something: its player became the audio host and the `audio.library` capability (2026-11-04).
Its library screens were never moved, which is why it is the largest piece left.

## 1. Drop what only older servers and the Alpha needed

Small and independent; unblocked by the no-compatibility rule.

- [ ] Status's previous interface: its `page.js`, `mobile/src/status/`, the Home card, the
  `StatusHome` route, `DEDICATED_SCREENS`' Status entry and the `KNOWN_*` lines (after the
  owner's OK on Status's shared interface).
- [ ] The fallback icons for servers before UI contract 1.0 (`mobile/src/satellites/icons.ts`'s
  name list); every Satellite declares `icon_name`.
- [x] The v0 `mobile` route: Music's, Photo's and Status's `mobile` routes, the Engine's
  `mobile_ui` field, the app's `DeclarativeScreen` and `SatelliteDetailScreen`, their tests.
- [ ] The audio host's `fallbackProvider` and `MUSIC_LEGACY_PROVIDER` (servers without the
  `audio.library` capability).
- [ ] The app's checks for an Engine without `/api/catalog` or `ui` fields, wherever they only
  served the Alpha.
- [ ] Docs: the "Backward compatibility" part of `ui-contract.md`, `media-audio.md`'s
  "Compatibility", and the Alpha notes in `mobile/README.md`.

## 2. File Explorer (R1)

From [`file-explorer-migration.md`](file-explorer-migration.md). F1 is done.

- [ ] **F2 - List paging:** `more` on `list` in the contract (Engine, both clients, fixtures);
  `view/folder` with `limit` and `cursor`; tested on 10,000 entries.
- [ ] **F3 - File page:** details, picture preview, Download, Share, and Open (`download` with
  `open: true`: a new tab on the web, the system viewer on Android through
  `StarCoreFilesModule.kt`).
- [ ] **F4 - Management:** new folder, rename, delete, through forms and confirms; the Locked
  Folder's guard still refuses.
- [ ] **F5 - Upload:** the `upload` action on both clients (pick files, stream them, confirm a
  replacement on `409`, report each file).
- [ ] **F6 - Default:** drop `preview`; `docs/satellites/file_explorer.md`; CHANGELOG.
- [ ] **F7 - Remove** `page.js` and `page.css`.
- [ ] Decide: the storage themes (classic, bar, donut, orbital) go with `page.js`
  (recommended), or become a shared block.
- [ ] Optional: a clickable breadcrumb (a horizontal list in the contract).

## 3. Photos without its own interface (R2)

From [`photos-parity-audit.md`](photos-parity-audit.md).

- [ ] **Settings (#29):** repeatable form rows in the contract, so the `source_paths` mappings
  are a `form`; the `own: "settings"` entry goes.
- [ ] **Phone sync (#28):** a generic client capability (for example `media.sync`): the app
  uploads the phone's new photos to whichever Satellite provides it, with Wi-Fi only, Sync now
  and the permission screen as shared app code. `App.tsx` no longer imports `src/photo/`; the
  manifest's permissions belong to the capability.
- [ ] **The Locked Folder (#37):** stage 4.
- [ ] **Icons shipped by the Satellite (#38):** a declared `icons/` folder, validated by the
  Engine (single colour, no script), drawn by both clients with a shared icon as fallback.
- [ ] Then remove `satellites/native/photo/mission_control/page.js` and `page.css`,
  `mobile/src/photo/`, its routes in `MainTabs.tsx` and its `DEDICATED_SCREENS` entry.
- [ ] Optional, from the audit: the summary's tools note (#5), album group hints (#6), bulk
  remove from an album (#10), map cluster preview (#15), exposure details and map link (#20),
  select all and bulk routes (#23), one album save per pick (#32).

## 4. The Locked Folder through `media.vault` (R3)

Needs its own security audit before implementation, as M5 had
([`archive/m5-locked-folder-actions-audit.md`](archive/m5-locked-folder-actions-audit.md)).

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
  other through capabilities; File Explorer's `locked_folder_guard.py` becomes a
  `files.protected` capability. Their comments naming each other go with them (about 130).
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
  Music's page (`mission_control/media/keys.js` looks for `.mu-root`).
- [ ] Then remove Music's `page.js`, `page.css`, `views/`, `ui/`, `mobile/src/music/`,
  `builtins.tsx`'s Music entries and its `DEDICATED_SCREENS` entry; `builtins.tsx` goes when
  empty.

## 6. Leftovers the guard can't see

`test_client_modularity.py` checks Satellite names as string literals and object keys in the
clients' code, and every comment of shared code (the Engine, Mission Control, the app outside
its Satellite-specific folders, its Kotlin and manifest). It does not check identifiers or
user-facing text.

- [ ] **Neutral player wording:** the web bar's "Music player" label, "Open StarCore Music on
  your phone", the Android Devices panel's "Music streams…".
- [ ] **Neutral names in the audio hosts:** the `MusicPreferences` type, `musicKeys`, the test
  IDs `music-disc`, `music-mini-player` and `music-player-retract`.
- [ ] **Stored keys** `starcore.music.*` (web) and `starcore_music_*` (Android) renamed; with
  no compatibility to keep, a one-time reset of the local queue and player state is acceptable.
- [ ] **The Kotlin package** `com.starcore.mobile.music` renamed to `media`.
- [ ] **The guard's code check extended to the Engine** (the CLI's `Status` column label and
  its help examples need rewording or an allowance).

## Order (validated by the owner on 2026-11-13)

1. Stages 1 and 6: the cleanup, small and safe, so there is less code to carry.
2. File Explorer (2): under way; its paging, upload and open serve Music and the Locked Folder.
3. The Locked Folder (4): a security audit first. It unblocks the end of Photos.
4. Photos (3): settings, phone sync and icons, then its own interface goes.
5. Music (5): the largest, last, reusing everything built before. An audit first.
6. Stabilisation before the stable release: the bugs, security points and checks listed in
   [`roadmap.md`](roadmap.md) (not the light theme, which waits until after it).

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
