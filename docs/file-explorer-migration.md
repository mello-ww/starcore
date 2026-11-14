# File Explorer migration plan (2026-11-12, at 425ec1b; F1 done at 9c79049)

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
| 3 | Storage themes (classic, bar, donut, orbital; per-browser preference) | ✅ | ✗ | Decided in F7: replaced by the shared `metric` bars and retired with `page.js` | F7 | – |
| 4 | Folder listing: icon, name, size, date | ✅ | ✗ | ✅ fixed in F1: `folder` page with a `path` param; `view/folder?path=` returns display-ready rows, folders then files | F1 | M |
| 5 | Breadcrumb and Up | ✅ | ✗ | ◐ F1: the full path and an Up button (All locations at a drive's root); clickable segments would need a horizontal list (C, later) | F1 | S |
| 6 | Locked Folder entry shown with a lock | ✅ badge | ✗ | ✅ fixed in F1: a lock icon and "Locked" in place of the date; the server guard stays what protects it | F1 | S |
| 7 | Large folders (thousands of entries) | ◐ every row in the DOM | ✗ | ✅ fixed in F2: `more` on `list`; `view/folder` pages each list 200 rows at a time (`part`, `cursor`, `limit`) | F2 | M |
| 8 | File details | ✗ | ✗ | ✅ fixed in F3: `file` page from a file's row, `view/file?path=`: size, date, type, folder; an `image` preview for a picture up to 20 MB | F3 | S |
| 9 | Download | ✅ | ✅ action exists (M12) | ✅ fixed in F3: on the file page (`content?download=1`) | F3 | S |
| 10 | Share | ✗ | ✅ action exists (M12) | ✅ fixed in F3: on the file page | F3 | S |
| 11 | Open with the system (new tab / Android viewer) | ✅ new tab | ✗ | ✅ fixed in F3: `download` with `open: true` (web: new tab; Android: `ACTION_VIEW` through the `FileProvider`); the Engine sandboxes an HTML, SVG or XML file opened in a tab | F3 | M |
| 12 | New folder | ✅ prompt | ✗ | ✅ fixed in F4: a `form` on the folder page (`mkdir`), then `refresh` | F4 | S |
| 13 | Rename file or folder | ✅ prompt | ✗ | ✅ fixed in F4: a `form` on the file page and the folder page (`rename`), prefilled with the name, then `back` to the folder, which reloads | F4 | S |
| 14 | Delete (confirm) | ✅ two-tap | ✗ | ✅ fixed in F4: a `danger` button with a `confirm` (`delete`), then `back` | F4 | S |
| 15 | Upload, several files, overwrite on conflict | ✅ | ✗ | ✅ fixed in F5: an Upload files button on the folder page (`upload` action, below), the unchanged `upload` route, a replacement only once confirmed, then `refresh` | F5 | L |
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
    "conflict": {"confirm": "A file with this name is already in this folder. Replace it?",
                 "route": "upload?path={$params.path}&name={$value.name}&overwrite=1"},
    "then": "refresh"}
   ```

   - `$value.name` is the picked file's name, cleaned by the same rule as `download` names.
   - A `409` answer asks `conflict.confirm`, which the client shows under the file's name (the
     contract has no text templates), then retries on `conflict.route`; cancelling skips that
     file. Without `conflict`, a `409` is a failure. Each file is reported; partial success is
     never shown as complete.
   - `then` is `refresh` or `back`; the action has no `body`, `method` or `confirm`, and is a
     page's own: not in a selection or a tile's quick actions.
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
- **F2 - List paging.** Contract `more` on `list` (the Engine's validation, the vocabulary,
  shared fixtures), both renderers; `view/folder` gains `part`, `cursor` and `limit`. **Done.**
  The first page holds 200 folders and 200 files with the folder's totals; each list then
  pages on its own from the last name shown, so a change in the folder between pages never
  repeats or skips what was already shown. Only the page's rows are examined (one stat each on
  Linux). Tests: a folder of 10,000 files and 250 folders, a folder that changes between pages,
  names differing only by case, bad parameters; both clients' paging rules. Checked on the
  demo: the web pages through 2,500 files in order, none twice; on Android, past about 1,500
  rows mounted in the page's own scrolling, the page saturated.
- **F2b - Virtualized lists on Android.** A page with a paged list among its own blocks is drawn
  as one virtualized list (`mobile/src/satellites/ui/VirtualListPage.tsx`): its blocks and the
  rows of each list, folders then files, with each list loading its next page as its own end
  nears the screen. Rows are memoized, so a page arriving redraws none already shown. **Done.**
  Checked on the emulator (2026-11-14, software rendering, development build): flinging
  through 300 folders and 10,000 files reached the last file in about nine minutes of
  continuous flings, with no page failing; the JavaScript thread went back to idle as soon as
  the flinging stopped, at about 400 MB.
- **F3 - File page.** Details, picture preview, Download, Share, Open (`download` + `open`).
  Kotlin `open` in `StarCoreFilesModule.kt`; web new tab. **Done.** A file's row opens the
  `file` page (`view/file?path=`, behind the same guard as `content`). Open is a download with
  `open: true`: Mission Control opens the route in a new tab with no handle on its page, and
  the app fetches the file into its private `cache/opened` and hands it read-only to the
  phone's viewer (`ACTION_VIEW`), so Open shows even where saving to Downloads can't. Since an
  opened file is a document on Mission Control's origin, the Engine now sends every Satellite
  file with `nosniff`, and an HTML, SVG or XML one with `Content-Security-Policy: sandbox`.
  Tests: the route's details, preview limit and errors; the document's actions; the app's
  module and the page's buttons; the web's new tab; the sandbox headers.
- **F4 - Management.** New folder, rename, delete through forms and confirms; the guard
  refuses inside a locked Locked Folder exactly as today. **Done.** No new route or contract
  feature: the folder page has a New folder form (`mkdir`) and, below a drive's root, a
  prefilled Rename form and a confirmed Delete; the file page has the same Rename and Delete.
  A rename or delete goes `back` to the folder, which reloads, so no page for a path that no
  longer exists stays in the history. A page's forms are told apart by their field keys, so two
  forms on one page must not both ask for `name` (the create form's key is `folder`). Tests:
  the document's routes, confirms and root rule; the app's forms and its confirm; the guard's
  and the routes' own tests are unchanged.
- **F5 - Upload.** The `upload` action on both clients, with conflicts and per-file reporting.
  **Done.** The contract's `upload` is validated by the Engine with shared fixtures. Mission
  Control picks with a hidden file input and streams each file as a `fetch` body
  (`mission_control/ui/upload.js`); the app picks with the system document picker and streams
  from `StarCoreFilesModule.kt` with a fixed length, copying a document of unknown size to its
  cache first (`mobile/src/files/upload.ts`). Both send files one after another, ask before
  each replacement and end with one report ("Uploaded 2 of 3 files. Kept the existing
  notes.txt."). The folder page's Upload files button uses the existing route, so its 2 GB
  limit, `.part` file and Locked Folder guard are unchanged. Tests: the contract's fixtures,
  both clients' runners and reports, the app's module wrappers and button, the document's
  routes.
- **F6 - Default.** Drop `preview`; `page.js` stays as the Developer Mode fallback. Checked on
  the web, the emulator and the phone. New `docs/satellites/file_explorer.md`, CHANGELOG.
  **Done.** `ui.json` no longer says `preview`, so Mission Control draws the shared interface
  by default and Developer Mode switches to `page.js`; the app already opened it. Checked on the
  web and the emulator (the phone is the owner's).
- **F7 - Retire `page.js` and `page.css`**, once validated in use, with the storage themes.
  **Done.** Both files are removed (1,513 lines), with the four storage themes (classic, bar,
  donut, orbital): the shared `metric` bars replace them, as recommended. File Explorer's
  `mission_control/` now holds only its icon, so Mission Control shows no switch to a previous
  page for it, and the web and Android draw the same `ui.json`. Nothing outside the Satellite
  referenced the page.

## What this leaves outside Satellite folders

File Explorer's own code already lives in its folder: its web page is under the Satellite, and
the app has no screen of its own for it. This migration gives Android the feature and adds
only generic contract features; it removes no entry from `engine/tests/test_client_modularity.py`.
One thing still names another Satellite: `locked_folder_guard.py`, which becomes a
`files.protected` capability in R3 of [`remaining-work.md`](remaining-work.md),
where everything else left outside Satellite folders is listed.
