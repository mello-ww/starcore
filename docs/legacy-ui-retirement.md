# Retiring Satellite-specific interfaces (2026-11-12, at 878954c)

The goal for the first stable release: adding or changing a Satellite needs no change to the
Engine, Mission Control or the Android app. A Satellite carries everything it needs (its
`ui.json`, routes, icons), and no code outside a Satellite's folder is written for one
Satellite. Clients implement the UI contract and capability protocols, never a Satellite.

**Done means:** `engine/tests/test_client_modularity.py` has empty `KNOWN_COUPLINGS`,
`KNOWN_IMPORTS` and `KNOWN_CROSS_SATELLITE`, and no Satellite-specific folder is left in
`SATELLITE_SPECIFIC`. A Satellite's own `mission_control/page.js` is no longer used by a
first-party Satellite (the mechanism stays, documented as a web extension).

Each step follows the usual rule: the shared interface reaches parity first, the old one stays
in Developer Mode for a release, then it is removed with its modularity entries.

## What is left (at 878954c)

| Satellite | Web | Android | Shared interface |
|---|---|---|---|
| Status | `page.js` fallback | `mobile/src/status/` for servers older than its `ui.json`, Home card | ✅ default (1.1) |
| Photos | `page.js` in Developer Mode; still opened for the Locked Folder | `mobile/src/photo/` in Developer Mode; still opened for settings, phone sync and the Locked Folder; background sync started by `App.tsx` | ✅ default (1.2) |
| Locked Folder | `page.js`, hosted by Photo's page | `mobile/src/lockedFolder/`: its screens and the unlock prompt for `media.vault` | ◐ moving photos in only (`secure`) |
| Music | `page.js` | `mobile/src/music/`, wired by `builtins.tsx` | ◐ the shared audio host and `play`; no `ui.json` |
| File Explorer | `page.js` | none (generic detail only) | ✗ planned (`file-explorer-migration.md`) |
| Older servers | - | `mobile/src/satellites/icons.ts`, `DEDICATED_SCREENS` in `HomeScreen.tsx` | - |
| Between Satellites | Photo's `page.js` hosts the Locked Folder | - | `locked_folder_guard.py`, `photo/private_media.py`, `locked_folder/vault.py` |

## Stages

Smallest first; each stage is its own plan and commits.

### R1 - File Explorer on `ui.json`
[`file-explorer-migration.md`](file-explorer-migration.md), F1-F7. Adds `list` paging,
`download` + `open` and the `upload` action to the contract. Gives Android a file browser.

### R2 - Photos without its own interface
From [`photos-parity-audit.md`](photos-parity-audit.md):
- **Settings (#29):** repeatable form rows in the contract, so `source_paths` mappings are a
  `form`. The `own: "settings"` link goes.
- **Phone sync (#28):** a generic client capability (`device.background-tasks` or
  `media.sync`): the app uploads the phone's new photos to whichever Satellite provides a
  sync capability, with Wi-Fi-only, Sync now and the permission screen as shared app code.
  `App.tsx` no longer imports `mobile/src/photo/`.
- **Locked Folder (#37):** see R3.
- Then remove `satellites/native/photo/mission_control/page.js`, `mobile/src/photo/`, Photo's
  `MainTabs.tsx` registrations and its `DEDICATED_SCREENS` entry.

### R3 - The Locked Folder through `media.vault`
- Browse, view and move out from the shared interface while unlocked, through `media.vault`
  operations that only answer with a grant (never a listing without one).
- The unlock prompt stays native, but as the app's implementation of the `media.vault`
  protocol: moved from `mobile/src/lockedFolder/` into generic app code (for example
  `mobile/src/vault/`), which knows the protocol, not the Satellite.
- Sections discovered from the catalog instead of Photo naming the Locked Folder; Photo's
  `private_media.py` and the vault's `vault.py` reach each other through capabilities.
- File Explorer's `locked_folder_guard.py` becomes a `files.protected` capability: File
  Explorer asks whichever Satellite protects paths, without naming it.
- Then remove the Locked Folder's `page.js`.

### R4 - Music on `ui.json`
The largest piece. Library pages (albums, artists, playlists, tracks, search) as media lists
and grids playing through the shared audio host; settings and equalizer as forms; offline
downloads as a generic client capability (keep tracks on the device); the audio host's track
menu declared by the document instead of `MUSIC_AUDIO_EXTENSIONS`. Then remove
`mobile/src/music/`, `builtins.tsx`'s Music entries, `MUSIC_LEGACY_PROVIDER` and Music's
`page.js`. Its own plan comes first, as for Photos.

### R5 - Older servers and leftovers
- Status's `page.js`, `mobile/src/status/` and the Home card, once Status's `ui.json` has been
  validated for a release (`satellites/status.md`, "Status's migration").
- `icons.ts`'s fallback list and `DEDICATED_SCREENS`, once servers older than UI contract 1.0
  are no longer supported (a decision tied to a release).
- Satellite-provided icons (Photos #38): a Satellite ships the icons its `ui.json` uses.
- The v0 `mobile` route and `DeclarativeScreen`, once nothing uses them.
- `builtins.tsx` is removed when it is empty.

## Order and dependencies

R1 is independent and comes first. R3 needs nothing from R1 but unblocks the last part of R2.
R4 is independent of the others. R5 waits for a release decision on older servers.
