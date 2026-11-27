# Open with, Show in folder: an audit and a plan (2026-11-27)

The owner asked for a way to link Satellites without coupling them: from File Explorer's
file page, open an image or a video in Photos and a sound in Music; from Photos and Music,
show an item's file in File Explorer. File Explorer's file page lists the Satellites that can
open the file ("Opens with"), each a link to that Satellite's page on it. Decided by the owner:
a sound outside Music's library **plays directly**, and **can still be added to a playlist**.

This file is the audit (what exists, what is missing, the risks) and the plan (contract
change 16, milestones O1 to O6). O1, the contract change, is done (see "What O1 built"); no
Satellite uses it yet.

## What exists

- **The capability registry.** A Satellite declares `[provides."name"]` in `satellite.toml`
  with a version and `operations` (name to route); the Engine lists them in `GET /api/catalog`,
  and `starcore.capabilities` runs another provider's operation in-process with the user's
  session (`call(..., token=)`), or as a Satellite asking through the Engine (`caller=`).
  `providers()` already returns every provider of one capability, so two Satellites can both
  offer the same one.
- **`files.browse`** (File Explorer): only `list`. Its routes (`content`, `view/file`) run every
  path through `paths.resolve_path` and `protection.guard`, the single check for the roots it
  may serve and for the areas a `files.protected` provider (the Locked Folder) holds.
- **`media.gallery`** (Photos): items by id only. `resolve` answers whether an id is in the
  active library, `adopt` takes a file in as an import would. Nothing finds an item by path.
- **`audio.library`** (Music): tracks by id only (`track`, `resolve = "playback"`, stream).
  Its scanner indexes the configured sources; nothing finds a track by path, and a playlist
  holds track ids (an entry whose track left is kept as `missing`).
- **Actions in the UI contract.** `navigate` stays inside one Satellite; `section` opens only a
  Satellite hosted in another's page (`section_of`). No action opens another Satellite's page,
  and none names a capability to find its provider. So the link has to be a new action.
- **`requires`** (change 14) hides a block a client cannot run; the same rule, applied to the
  catalog, hides an action no provider can serve.

## What is missing

1. A way for a Satellite to say which files it opens, and an operation that takes a path and
   answers which of its pages shows it.
2. A way for File Explorer's page to list those Satellites, from the catalog, for one file.
3. A client action that runs that operation and opens the answered page in the other
   Satellite, and one that opens a path's folder in whichever Satellite browses files.
4. Path lookups: Photos and Music finding their item for a path, and the reverse (an item's
   path, which both already know server-side).
5. Music: a track outside its sources, playable and kept in playlists.

## Contract change 16 (UI contract 1.2)

**A capability, `files.open` (version 1)**, which any number of Satellites may provide:

```toml
[provides."files.open"]
version = 1
operations = { open = "open" }
types = ["image", "video"]                 # what it opens: kinds, or extensions
extensions = [".jpg", ".png", ".mp4"]      # optional, narrower than the kinds
label = "Photos"                           # how "Opens with" names it
```

The Engine validates `types` (a closed list: `image`, `video`, `audio`; more kinds can be
added to the table when a Satellite needs them) and `extensions` (lower-case, a dot, 1 to 10
characters, at most 64) and publishes them in the catalog with `label`.
The kinds map to extensions in one shared table (`contracts/ui/vocabulary.json`), so both
clients and the Engine agree on what "audio" covers.

`open`: `POST open {"path": "..."}` with the user's session, answering
`{"page": "<one of its pages>", "params": {...}}`, or 404 when it cannot open that file.

**`files.browse` gains two optional operations**: `locate` (`GET locate?path=` answering
`{"page": "folder", "params": {"path": "<the folder>", "select": "<the file's name>"}}`) and
`stat` (`GET stat?path=`, one entry the session may browse, 404 otherwise).

**A block, `openers`**: `{"type": "openers", "path": "$.path", "label": "Opens with"}`.
The client takes the file's extension, filters the catalog's `files.open` providers by it,
and draws one link per provider, by its `label` (hidden when there is none). File Explorer's
file page adds it under its fields.

**The block's links and one action**:

- Each pill of the `openers` line runs that provider's `open` and opens the answered page of
  that Satellite (its own route `#/satellite/<name>/<page>` on the web, its screen on Android,
  with Back returning to the file). The block carries no action of its own: a document can't
  name a provider.
- `{"locate": "$.path"}`: runs `files.browse`'s `locate` and opens File Explorer's folder page.
  Hidden when no Satellite provides it. (`reveal` was the first name, but a protected
  document's route action already has a `reveal` key, which shows a secret once.)

The client never builds another Satellite's route by itself: the provider answers which page.
Every `ui.json`, both clients' validators and the shared fixtures change together (the rule
for a contract change).

## What each Satellite does with a path

**The path is never trusted.** It comes from a client, so an opener never opens it directly:
it asks `files.browse` through the Engine with the **user's own session**
(`capabilities.call("files.browse", "stat", query={"path": ...}, token=...)`, an operation to
add over `view/file`), so File Explorer's roots, its users' rights and the Locked Folder's
protection apply exactly as when the user browses. A refusal there is a 404 from `open`. With
no File Explorer, nothing can be opened by path (the "Opens with" line has nowhere to be
anyway).

- **Photos** (`types = ["image", "video"]`): a path in its library opens the gallery's viewer
  on that item (a lookup by path to add to its index). Any other path opens a page `file` of
  its own showing the picture or the video, its bytes read through `files.browse`'s `content`
  with the user's session (never Photos reading the disk itself), with **Add to library**
  (the existing `adopt`) and **Show in folder**.
- **Music** (`types = ["audio"]`): a path in its library opens that track's page and plays it.
  Any other path **plays directly**: Music reads its tags and keeps it as an **external track**
  (a row flagged `external`, with its path), hidden from the library, search and statistics,
  but playable, queueable and **addable to playlists** like any track. At every play (and when
  a playlist loads), Music asks `files.browse` again whether the user may still read it; a
  file moved, deleted or put in the Locked Folder shows as `missing`, the state a playlist
  already has. External tracks no playlist, queue or history holds are dropped after a while.
  Streaming and transcoding read the file only once that check passed.
- **Show in folder**: an action on Photos' viewer and on Music's track page, through
  `locate`, for an item whose path the Satellite knows (never sent to the client unless the
  user may browse it: the action carries the item id, and the Satellite resolves the path
  server-side before asking `locate`).

## Security

- One guard for paths, File Explorer's, reached with the user's session: no Satellite gains a
  way to read a file the user could not open in File Explorer.
- The Locked Folder: `protection()` refuses a protected path for every opener, and an external
  track or a viewed file is re-checked at each read, so a file locked after it was added stops
  playing. Nothing about a protected file (its name, its tags) is stored.
- `open` and `locate` refuse what is not a regular file or folder, follow File Explorer's rules
  for links, and log nothing of the path beyond what File Explorer already logs.
- The answered `page` must be one of the provider's own pages; the client refuses anything
  else (the same check as `navigate`).
- To review in O5: a race between the check and the read (a link swapped under the path), the
  cost of re-checks on a long playlist (batched), and what an external track's tags may carry.

## Android parity

The `openers` block and the `locate` action in `mobile/src/satellites/ui/` (the catalog is already
in `BlockContext.providers`). Opening another Satellite's page uses the same stack as opening a
Satellite from the list, with Back returning to the file. Direct playback goes through the
shared AudioHost like any track (the stream route is the same). Nothing Satellite-specific in
the app.

## Milestones

| Step | What | Model | Effort |
| --- | --- | --- | --- |
| O1 | Contract change 16: `files.open` (types, extensions, label), `openers`, `locate`; Engine validation and catalog, vocabulary, fixtures, both clients (done) | Opus 5.5 | high |
| O2 | File Explorer: `stat` and `locate` operations, "Opens with" on the file page | Sonnet 5.5 | high |
| O3 | Photos: lookup by path, `open`, its `file` page through `content`, Show in folder | Opus 5.5 | high |
| O4 | Music: lookup by path, `open`, external tracks (direct playback, playlists, re-checks, clean-up), Show in folder | Opus 5.5 | xhigh |
| O5 | Security review of O1 to O4 | Opus 5.5 | xhigh |
| O6 | Web demo and emulator runs, docs, a new APK | Sonnet 5.5 | medium |

Tests: the Engine's catalog validation and `open`/`locate` (a protected path, a path outside
the roots, a user without File Explorer, a file locked after it was added); the clients'
`openers` filtering and `locate` (`contracts/ui/tests`, Jest); Music's external tracks in
a playlist going `missing`.

## What O1 built

- **Vocabulary** (`contracts/ui/vocabulary.json`): the `files.open` capability (operation
  `open`, and `declares` for `types`, `extensions`, `label`), `file_kinds`, `files.browse`'s
  optional `locate` and `stat`, the `openers` block, the `locate` action in `since` 1.2, the
  `opener_extensions` limit.
- **Engine**: `normalise_provides` checks and keeps what a `files.open` provider declares, a
  provider with a broken one is left out; the catalog publishes it; the validator checks the
  block and the action (never in a protected document, `locate` not in a selection, a tile's
  quick actions or the player's menu).
- **Clients**: `openersFor`, `locateProvider` and the check of an answer (`openedSection` on the
  web, `openedPage` on Android: a page id and string params, nothing else) in each contract
  module. Mission Control draws the line as pills and opens the answer through a new host
  callback (`satellites.open`, which refuses a Satellite without a shared interface); Android
  pushes the provider's shared interface. Both hide the line, and the `locate` control, when
  nothing can serve them.
- **Fixtures**: one valid document using both, seven refused ones.
