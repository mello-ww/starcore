# Open with, Show in folder: an audit and a plan (2026-11-27)

The owner asked for a way to link Satellites without coupling them: from File Explorer's
file page, open an image or a video in Photos and a sound in Music; from Photos and Music,
show an item's file in File Explorer. File Explorer's file page lists the Satellites that can
open the file ("Opens with"), each a link to that Satellite's page on it. Decided by the owner:
a sound outside Music's library **plays directly**, and **can still be added to a playlist**.

This file is the audit (what exists, what is missing, the risks) and the plan (contract
change 16, milestones O1 to O6). O1 to O4 are built (see "What O1 built" to "What O4 built"),
and O5 reviewed them (see "Security review of O1 to O4"); O6 is left.

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
- Reviewed in O5 (see "Security review of O1 to O4"): a race between the check and the read
  (a link swapped under the path), the cost of re-checks on a long playlist (batched), and what
  an external track's tags may carry.

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

## What O2 built

- File Explorer's `files.browse` gains `stat` and `locate` (`api.py`), behind the guard of
  `content` (`paths.resolve_path`, then `protection.guard`): a path outside its roots, a protected
  one, a missing one or a relative one answers as `content` does (400, 403, 404), and a file
  answers the folder page with `select` set to its name. The folder page does not read `select`
  yet; it is only carried in the answer.
- Its file page ends with the `openers` block ("Opens with"). Nothing shows there until a
  Satellite provides `files.open` (O3, O4).

## What O3 built

- `files.browse` gains a third optional operation, `content`, because a Satellite can only ask
  a provider for what it declares: Photos shows a file from it once `stat` has passed.
- Photos (`opening.py`): `open` (the `file` page for a supported file the session may browse,
  404 otherwise), `gallery/file`, `file/content` (the bytes, served inline with Photos' own
  content type, never as a download) and `file/add`. A path in the library is recognised by its
  name and size (and its folder, when the item remembers one), not by reading the file.
- The library's viewers (library, search, albums, map) gain **Show in folder** (`locate` on the
  item's `folder`), hidden when there is none.
- Not done: opening the gallery's own viewer on a library item (the `file` page shows it and
  says it is in the library).

## What O4 built

- Music (`opening.py`): `open` answers the track page, for a library track at that path or for an
  **external track** (migration 3: `external`, `last_used`; tags read like a scan's, no album,
  artist or cover). `VISIBLE` leaves external tracks out of the library everywhere; playlists
  and the queue keep them; a scan does not judge them (a source holding their folder takes them
  in at the next scan).
- Re-checks: `opening.refresh` asks `files.browse` `stat` again, with the asking session, for
  the external tracks of a playback plan or stream, a playlist's load, a queue's expansion, a
  lyrics call and the track page; a failure sets `missing`, a success clears it.
- Clean-up: `opening.purge`, at each open, drops external tracks held by no playlist, saved
  queue or play of the last 30 days and unused for that long.
- The track page (`tracks/<id>?page=1`) gains **Add to playlist**, **Show in folder**
  (`location`, only for a file the session may browse) and the "Not in the library" note.
- Decided while building: opening a library track shows its page (Play is one tap away, the
  contract's answer being a page, not a command); a like on an external track is not listed under
  Liked Songs (the library's view), and is dropped with the track, with its plays.

## Security review of O1 to O4 (O5)

Reviewed: the Engine's `files.open` validation and catalog, `capabilities.call` and
`protection`, the HTTP gate and device credentials, File Explorer's `stat`, `locate` and
`content`, Photos' and Music's `opening.py` and every Music route that reads a track's file,
and both clients' `openers`, `locate` and the check of an answer.

### What held

- **One guard for paths.** Photos and Music never take a path from a client as it is: each
  question goes to `files.browse` with the asking session, which resolves it (links followed)
  and runs the protection check on where it really leads. A refusal there, whatever the reason,
  is a 404 that says nothing more.
- **The session.** `capabilities.call` runs the provider's route in-process, after the asking
  route passed the HTTP gate, with the same token: File Explorer sees the same session as when
  the user browses. StarCore has no per-user rights on Satellites, so nothing is reached that the
  user could not reach in File Explorer.
- **Device credentials** reach only the routes of their own capability's operations (Photos'
  `backup/*`), never `open`, `file/*` or `gallery/file`.
- **What the client opens.** Both clients take the answer as a page id (`[a-z][a-z0-9_-]{0,47}`)
  and string params, and open it only in the Satellite they asked, only if it has a shared
  interface; the answer cannot name another Satellite. A page id the provider does not have
  opens that interface's entry page, as any unknown page does there. The `label` is checked by the Engine (1 to
  40 characters) and drawn as text; an external track's tags are drawn as text like a library
  track's.
- **What is served.** Photos serves a file inline only as a picture or video type of its own
  table (never SVG or HTML), with `nosniff` and `private, no-store`.
- **Cost.** A re-check asks about at most 200 files at a time; ids are 64-bit hashes, not
  guessable; the clean-up bounds the rows that opening many files leaves.

### What it found, and the fixes

1. **A protected area open for the session passed `stat`** (the guard lets an open area
   through). Music would then keep an external track of a Locked Folder file (its tags, its
   path, its transcodes), and Photos' **Add to library** would copy it into the library, outside
   the area. Both now ask `starcore.capabilities.protection` themselves: Music refuses to open
   such a file (403, "in a protected area"), Photos shows it (nothing is kept) but hides **Add to
   library** ("In a protected area") and refuses `file/add` (403).
2. **A file a protected area comes to hold** (the area's path set over an existing folder):
   Music's re-check now asks the same question and drops the external track with everything kept
   about it (tags, plays, likes, lyric offsets, transcodes, `opening.forget`); a playlist keeps
   the entry, missing and nameless.
3. **A link put in a track's way.** An external track is the file at the real path it was
   opened at. When that path later leads elsewhere (a folder replaced by a link), the re-check
   answered for the other file, and Music would have played it; it is now missing. Show in folder
   is not offered for a missing track.
4. **Lyrics beside an external track** were read without a check (a `.lrc` that is a link could
   lead anywhere). Each one is now read only if `files.browse` lets this session browse it where
   it is (`opening.readable`).
5. **Copies left behind.** A transcode of an external track stayed in the cache after its file
   left; it is dropped when the re-check finds the file gone and when the track is dropped
   (`Transcoder.forget`). The stream of an external track is served `private, no-store`, as File
   Explorer serves files, so the browser keeps no copy either.
6. **Show in folder** was hidden for a library track in a container Music does not open by path
   (`.mp4`): `location` now asks `stat` for any file, `open` still only for sounds.

Tests: `test_music_open` (eight more) and `test_photo_open` (one more); each fails without its
fix. The test of a lyric file that links elsewhere needs the right to make symbolic links (it is
skipped where Windows does not give it); the test of a link in a track's way uses a junction
there.

### What stays, accepted

- **The check and the read are two steps.** A link swapped in between them, in that instant,
  is not caught, in Music as in File Explorer's own `content`; doing it needs write access to
  the server's folders outside StarCore (File Explorer makes no links). A hard link to a
  protected file is the same file to every check, as it is for File Explorer. An encrypted Locked
  Folder holds only ciphertext, and the guard refuses it even when open.
- **A file moved into the Locked Folder** leaves its external track missing with its title in
  its playlists, as a library track does: the 404 says nothing about where a file went, on
  purpose. The track is dropped with the rest after 30 days when nothing holds it.
- **What a client keeps.** A track downloaded for offline listening stays on the phone, as any
  file downloaded from File Explorer does; the path of a file opened in Photos is in the page's
  address (the browser's history), as File Explorer's folders are.
- **Tags are read by the same code as a scan** (and FFmpeg for a transcode), on files the user
  could already put in a source by uploading them.
