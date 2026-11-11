# File Explorer migration plan (2026-11-12, at 425ec1b)

Moves File Explorer to the shared interface (`ui.json`) on both clients, the way Photos moved
(see `photos-parity-audit.md`). Compared from the code, not the docs:

- **Dedicated web:** `satellites/native/file_explorer/mission_control/page.js` (817 lines) and
  `page.css` (696 lines).
- **Android:** no screen of its own. The app shows only the generic Satellite detail, so the
  shared interface gives Android a file browser for the first time.
- **Server:** `api.py` routes `entries`, `content`, `upload`, `mkdir`, `rename`, `delete`; the
  `files.browse` capability (used by the `file-browser` block and the folder picker) stays as it is.

The goal is the same as for Photos: File Explorer carries everything it needs, and the shared
code it relies on is generic (any Satellite can use it), never written for File Explorer.

Legend: as in `photos-parity-audit.md`.
- **Platforms:** DW = dedicated web, SW = shared web, SA = shared Android.
- **Fix types:** C = generic contract or renderer feature, S = File Explorer server change,
  J = File Explorer `ui.json` only.

## Parity matrix

| # | Feature (dedicated web) | DW | SW / SA today | Fix | Milestone | Size |
|---|---|---|---|---|---|---|
| 1 | Locations: roots and drives | ✅ | ✗ | ✅ fixed in F1: `locations` page, a `list` from `view/locations` | F1 | S |
| 2 | Storage dashboard: machine total and per-drive usage | ✅ 4 themes | ✗ | ◐ F1: the machine total as a `metric` bar, each drive's free space and percentage in its row | F1 | S |
| 3 | Storage themes (classic, bar, donut, orbital; per-browser preference) | ✅ | ✗ | Decision pending; recommended: replaced by the shared `metric` bars, retired with `page.js` | F7 | – |
| 4 | Folder listing: icon, name, size, date | ✅ | ✗ | ✅ fixed in F1: `folder` page with a `path` param; `view/folder?path=` returns display-ready rows, folders then files | F1 | M |
| 5 | Breadcrumb and Up | ✅ | ✗ | ◐ F1: the full path and an Up button (All locations at a drive's root); clickable segments would need a horizontal list (C, later) | F1 | S |
| 6 | Locked Folder entry shown with a lock | ✅ badge | ✗ | ✅ fixed in F1: a lock icon and "Locked" in place of the date; the server guard stays what protects it | F1 | S |
| 7 | Large folders (thousands of entries) | ◐ every row in the DOM | ✗ | C: `more` paging on `list` (same shape as `media-grid`); S: `limit`/`cursor` | F2 | M |
| 8 | File details | ✗ | ✗ | J: `file` page: size, date, type, `image` preview for pictures | F3 | S |
| 9 | Download | ✅ | ✅ action exists (M12) | J | F3 | S |
| 10 | Share | ✗ | ✅ action exists (M12) | J | F3 | S |
| 11 | Open with the system (new tab / Android viewer) | ✅ new tab | ✗ | C: `download` with `open: true` (web: new tab; Android: `ACTION_VIEW` through the existing `FileProvider`) | F3 | M |
| 12 | New folder | ✅ prompt | ✗ | J: `form` then `refresh` | F4 | S |
| 13 | Rename file or folder | ✅ prompt | ✗ | J: `form` on the file or folder page, then navigate to the parent | F4 | S |
| 14 | Delete (confirm) | ✅ two-tap | ✗ | J: `confirm`, then `back` | F4 | S |
| 15 | Upload, several files, overwrite on conflict | ✅ | ✗ | C: `upload` action (below); S: unchanged route | F5 | L |
| 16 | Errors as notices | ✅ | ✅ generic | – | – | – |

## Contract additions (UI contract 1.2, unreleased, additive)

1. **`list` paging (`more`)** - `{"route": "...&cursor={$value}", "cursor": "$.next"}`, exactly
   as `media-grid`. Validated in the Engine, `mission_control/ui/contract.js` and
   `mobile/src/satellites/ui/contract.ts`, with shared fixtures.
2. **`download` with `open: true`** - fetches the route with the session, then opens the file
   with the platform: a new browser tab on the web, the system viewer on Android (an extension
   of `StarCoreFilesModule.kt`). Hidden where the client can't.
3. **`upload`** - the person picks one or more files on the device, and each is streamed as a
   raw body to a Satellite route:

   ```json
   {"upload": {"multiple": true}, "route": "upload?path={$params.path}&name={$value.name}",
    "conflict": {"confirm": "Replace {$value.name}?", "route": "upload?path={$params.path}&name={$value.name}&overwrite=1"},
    "then": "refresh"}
   ```

   - `$value.name` is the picked file's name, cleaned by the same rule as `download` names.
   - A `409` answer asks `conflict.confirm`, then retries on `conflict.route`; cancelling skips
     that file. Each file is reported; partial success is never shown as complete.
   - Web: a hidden `<input type=file>` and a streamed `fetch`. Android: the system document
     picker and a streamed POST in `StarCoreFilesModule.kt`, with the session header.
   - A client that can't pick files hides the control. Nothing reaches the Satellite but the
     route's POST.

No new block is needed: the rest is `list`, `form`, `metric`, `field`, `image`, `button` and
the existing actions.

## Milestones (one commit each)

- **F0 - This plan.**
- **F1 - Read-only browsing.** `ui.json` with `preview: true` (the web keeps `page.js` by
  default; Android opens the document). Pages `locations` (entry) and `folder` (`path` param).
  Server: `view/locations` and `view/folder` display routes (`views.py`; `ui` is a Core
  segment), sharing `entries`' directory read and the guard. **Done.**
  Tests: Engine route tests, document validation.
- **F2 - List paging.** Contract `more` on `list` in the three validators, fixtures, both
  renderers; `view/folder` gains `limit` and `cursor`. Tests on a folder of 10,000 entries.
- **F3 - File page.** Details, picture preview, Download, Share, Open (`download` + `open`).
  Kotlin `open` in `StarCoreFilesModule.kt`; web new tab.
- **F4 - Management.** New folder, rename, delete through forms and confirms; the guard
  refuses inside a locked Locked Folder exactly as today.
- **F5 - Upload.** The `upload` action on both clients, with conflicts and per-file reporting.
- **F6 - Default.** Drop `preview`; `page.js` stays as the Developer Mode fallback. Checked on
  the web, the emulator and the phone. New `docs/satellites/file_explorer.md`, CHANGELOG.
- **F7 - Retire `page.js` and `page.css`**, once validated in use, with the storage themes.

## What this leaves outside Satellite folders

File Explorer's own code already lives in its folder: its web page is under the Satellite, and
the app has no screen of its own for it. This migration gives Android the feature and adds
only generic contract features; it removes no entry from `engine/tests/test_client_modularity.py`.
What still names a Satellite outside its folder afterwards (planned in
[`legacy-ui-retirement.md`](legacy-ui-retirement.md)):

| Where | What | Way out |
|---|---|---|
| `mobile/src/music/`, `builtins.tsx` | Music's native screens | Music on `ui.json` (needs the audio host actions) |
| `mobile/src/photo/`, `MainTabs.tsx`, `App.tsx` | Photo's own screens, settings and background phone sync | Shared interface as default (done in M1-M14), then: settings as a form (repeatable rows), phone sync as a generic device capability, retire the screens |
| `mobile/src/lockedFolder/`, `builtins.tsx` | The Locked Folder's PIN and biometric prompt | Photos #37: the Locked Folder in the shared interface; the prompt is registered for the `media.vault` capability |
| `mobile/src/status/`, `HomeScreen.tsx` | Status's screen and Home card for servers older than its `ui.json` | Drop once those servers are no longer supported |
| `mobile/src/satellites/icons.ts` | Icons for servers older than UI contract 1.0 | Same; then Photos #38, icons shipped by the Satellite |
| `satellites/native/file_explorer/locked_folder_guard.py`, Photo ↔ Locked Folder | One Satellite naming another | A `files.protected` capability; the vault beside Photo's library through `media.vault` |
