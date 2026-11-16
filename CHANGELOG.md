# Changelog

All notable changes to StarCore. Versions follow [semver](https://semver.org/); the version
itself lives in the `VERSION` file (see `docs/releasing.md`).

## Unreleased

### Security

- **A phone is never told its photos are safe when nobody knows.** The phone's backup asks the
  server which files it already has. When a protected store (the Locked Folder) could not
  answer, every file the library didn't have was reported as already there, so the phone would
  have marked all of it as backed up and never sent it. The server now answers "ask again
  later" (`503`) and takes nothing in meanwhile; the app also ignores an answer that isn't the
  server's own (a Wi-Fi sign-in page). Free space is checked at every chunk of an upload, not
  once (`docs/photos-parity-audit.md`, "Security review of S1 to S4").
- **Another name for the Locked Folder's folder is still the Locked Folder.** On a Windows
  server, a path such as `\\?\C:\...` or the drive's loopback share opened the vault's folder
  without being recognised as it, so File Explorer, Photo and Music let a session without the
  PIN in. The vault is now told by its identity on disk as well as by its name. Linux servers
  were not affected (`docs/satellites/locked_folder.md`, "Security review of L0 to L6").
- **Android: the Locked Folder's viewer and prompts can't be captured.** A Modal is a window of
  its own and didn't take the app's capture protection, so a vault photo full screen, a PIN
  prompt or a new recovery key could be in a screenshot or a recording. Each now protects its
  own window.
- **`files.protected`'s `check` answers the server alone:** a client that asks gets `403`.

- **The Locked Folder and Photo no longer reach into each other's code.** Moves between the
  vault and the library go through the Engine, as `media.gallery`'s new optional `original`,
  `release` and `adopt`, and Photo asks whether a file was moved into the vault through
  `media.vault`'s new optional `sealed`, of every provider, enabled or not; one that can't
  answer keeps the file out (before, a Locked Folder whose runtime didn't exist yet let it in).
  All four are for the server alone: a request through the Engine carries its `caller`, which a
  client's request never has, so a client gets `403` (`docs/satellites/locked_folder.md`, L6).

- **Disabling the Locked Folder no longer opens it to File Explorer.** Disabling a Satellite
  needs only a session, not the PIN, and File Explorer's guard used to skip a disabled Locked
  Folder: a session that never gave the PIN could then list, read, rename and delete what was in
  the vault, including the unencrypted backups an encryption run keeps. The guard now protects
  the vault whether the Satellite is enabled or not, and the owner can still unlock it while it
  is disabled (`docs/satellites/locked_folder.md`, audit finding A1).
- **A locked session is no longer told where the vault is**: the Locked Folder's `status`
  answers `"path": null` and its settings leave the location out, with a note to unlock first.
  Before a PIN is set the location is shown as before, for setup (A5).
- **No Satellite can reach the Locked Folder by its path any more.** Protection used to be
  asked only by File Explorer and Photo: Music's scan took any folder, so a signed-in session
  could index and stream the audio files of an unencrypted vault. Every Satellite that takes a
  path now asks the Engine, which asks the new `files.protected` capability of every provider,
  enabled or not, and keeps the path closed if one can't answer. Music refuses to scan the vault
  and skips it inside a parent folder. File Explorer and Photo name no other Satellite for it
  (A2). The `files stat` command's `contains_locked_folder` is now `contains_protected`.
- **After a reload of the Locked Folder, File Explorer guards its current location.** The
  shared runtime kept reading the configuration from before the reload, so a location set after
  it was not the one guarded. The unlock table is also changed only under its lock now (A9).
- **An unlock of the Locked Folder ends after 90 seconds without use**, as well as after
  `session_timeout_seconds` as before. Its own page and screens, and any protected document,
  call the new `keep` every 30 seconds while they show the vault, and only then: a crashed tab,
  a lost connection or a killed app leaves the vault open 90 seconds at most, not 15 minutes.
  `status` never extends an unlock and reports `idle_seconds` (A3).
- **A biometric signature buys only what its challenge was asked for.** The purpose (a grant
  for one move, or a full unlock) is given with `biometric/challenge` and kept with the challenge
  on the server; a `for` sent beside the signature is refused before anything counts (A6). On
  Android, biometric unlock of the Locked Folder has to be turned on again once.

### Removed

- **File Explorer's own Mission Control page** (`page.js`, `page.css` and its four storage themes):
  its shared interface is now the only one, on the web as on Android, and the storage is shown
  by the shared `metric` bars. The "own page" switch in Developer Mode no longer appears for it
  (`docs/file-explorer-migration.md`, F7).
- **The Locked Folder's own web page and Android screens** (`locked_folder/mission_control/page.js`
  and `page.css`, `mobile/src/lockedFolder/`), with Photos' Locked Folder tab and its own Lock
  move on both clients (`lockedMove.js`, the viewer's Lock button). Its shared interface is now
  its only one, opened from Photos' tile, and a photo moves in through Photos' shared
  interface (`docs/satellites/locked_folder.md`, L8).
- **The old phone sync**, before its new form: Photo's standalone listener (its own port, one
  shared token, its upload page), the `sync` and `sync_upload` routes, the `sync_enabled`,
  `sync_host`, `sync_port`, `sync_token` and `sync_max_bytes` settings, `photo sync` and the
  sync line of `photo stats`, the "Phone sync" panel on Photo's own page and the button on
  Settings; in the app the background task, its section in Photo configuration, the
  `react-native-background-fetch` and camera roll libraries, and the media, boot and wake lock
  permissions. The app removes what the task kept on the phone at its next start. Photo's
  settings now take effect at once, with nothing left to restart. `source_paths` and
  `sync_default_path` stay for the new sync (`docs/photos-parity-audit.md`, S0).

### Added

- **The `sync` action (UI contract 1.2, contract change 4):** `{"sync": {"capability": "media.sync"}}`
  opens the client's own sync screen for the document's own provider; the document supplies
  nothing of it, and a client without the screen hides the control. `media.sync` opens the
  client capability `device.media-sync`, which replaces the reserved `device.background-tasks`.
- **Android: the phone backs itself up** (`device.media-sync`). A sync screen, opened from
  Photo's Phone backup page or Settings' "Phone backup", turns on a background backup of the
  phone's photos and videos to the server's `media.sync` provider: a new photo is sent within
  a minute, a run every six hours and when the app opens catches the rest, and a cut upload
  resumes where it stopped. Every folder by default, each can be turned off; Wi-Fi only unless
  "Use mobile data" is on; "Only while charging" if chosen; never on a low battery. It shows
  where it stands and what failed, with "Try again". It uses a device credential limited to
  the backup, kept under an Android Keystore key, and revoked when you sign out
  (`docs/photos-parity-audit.md`, S3). Tried on the emulator (S4): an item that failed is tried
  again when its backoff is over, not at the next six-hour run, and a photo taken while the
  app's process was dead is caught when the process starts.
- **The Engine ends an upload that goes silent:** a raw request body (an upload's chunk) that
  sends nothing for 60 seconds is ended there, its connection closed; what arrived is kept, so
  a phone that lost its network resumes from it instead of finding the file still being sent.
- **Photo's Phone backup page** (Albums' Phone backup button): each device that backs up to
  Photo, when it was last seen and how many files it sent, and a "Back up this phone" button
  that opens the app's sync screen; Mission Control hides it (`docs/photos-parity-audit.md`,
  S2).
- **Photo's phone backup, server side (`media.sync` v1):** `status`, `check` (what the server
  already has, erased and protected media included, without saying which), a resumable
  `upload` written straight to disk in chunks of 8 MiB and checked against its SHA-256, and
  `devices`. Media erased from the recycle bin is remembered by its digest and never taken back
  by a backup. The app's side comes next (`docs/photos-parity-audit.md`, S1).
- **Device credentials:** `POST /api/auth/devices` issues, to a signed-in session, a credential
  limited to one capability that allows it (so far `media.sync`): it reaches only that
  provider's routes for it, never expires, is stored hashed, and is listed and revoked with the
  sessions (`docs/api.md`, "Device credentials").

- **Biometric unlock turned on from the Android app's unlock card:** a full unlock offers "Use
  biometrics next time", and the PIN that unlocks then enrols the phone; an enrolled phone's
  card offers "Stop using biometrics on this phone". A move's prompt offers neither. This was
  only in the Locked Folder's old screens.

- **"Forgot your PIN?" in a protected document (UI contract 1.2):** a protected document may
  name a `forgot` page (`protected.forgot`, a page without params that the server serves
  without an unlock). Both clients' unlock cards then offer "Forgot your PIN?", which shows that
  page in place of the card; its way back, or its action, asks the store's status again. The
  Locked Folder's offers a new PIN with the recovery key, or says what else can be done
  (`docs/ui-contract.md`, "Protected documents").
- **Protected documents (UI contract 1.2):** a document can declare
  `"protected": {"capability": "media.vault", "setup": "<page>"}`, and both clients then ask
  the store's status before any page. They show the setup page when it isn't set up, their own
  unlock card when it is locked (PIN, and biometrics on Android) and the page once it is open.
  A `403` asks again, `keep` runs while it shows, and it locks when it closes or stays hidden
  for 10 seconds. It keeps nothing: no offline page, widget or share; on Android images only in
  memory, a window that can't be captured, and no "open in another app". The Engine accepts it
  only from the store's own Satellite (`docs/ui-contract.md`, "Protected documents").
- **The Locked Folder's shared interface, a preview** (`locked_folder/ui.json`, a protected
  document): a grid of everything in the vault in month groups, paged, with the picture or the
  video in a viewer, Move to Photos, Download and Delete forever, a selection, and Add files; a
  setup page that says what is missing without giving the location. Its own page and screens
  stay the default until it is validated; Developer Mode opens it (the top bar's switch on the
  web, a pill on Photos' card in the app's Satellites list). It reads two new views, `gallery`
  and `setup`, and changes the vault only through its existing routes
  (`docs/satellites/locked_folder.md`, "Shared interface").
- **Secrets, reveal and repeatable rows (UI contract 1.2, contract change 2).** An action of a
  protected document may ask for a PIN or a recovery key (`secrets`): the client asks in its own
  prompt, a new PIN twice, and puts the value only in that request's body, never in a form, the
  page's state, storage or a log. It may show a field of the answer once (`reveal`), in the
  client's own dialog until the person says it is stored. A form field of kind `rows` holds a
  list the person adds to and removes from. After every action of a protected document both
  clients ask the store's status again (`docs/ui-contract.md`, "Secrets and reveal",
  "Repeatable rows").
- **The Locked Folder's setup and settings in its shared interface:** the setup page chooses
  the folder, creates the PIN and sets a new one with the recovery key; a settings page changes
  the PIN, encrypts (showing the recovery key once), resumes or undoes a run, replaces or
  removes the recovery key, restores or deletes a backup, and delinks. It reads a new
  `settings` view, served only while unlocked, and every route still needs what it did. Enrolling
  a phone for biometric unlock stays in the app's own screens (`docs/satellites/locked_folder.md`).
- **Photos' settings in its shared interface:** Settings on Albums edits the phone folders as
  repeatable rows (each keeping its album), the default album for synced photos, the recycle
  bin's retention and the default import folder, through the existing `configuration` route,
  whose answer now carries a `message`. It reads a new `gallery/settings` view. Phone sync
  stayed Photo's own screen, opened from Settings (`{"own": "sync"}`, which replaced
  `{"own": "settings"}`), until S0 removed it (`docs/satellites/photo.md`).
- **A host lists the Satellites it hosts from the Engine** (`starcore.sections`): Photo's
  albums show each as a tile, with its title and icon, that opens through the `section` action.
  Photo's document no longer names the Locked Folder, and in the app a hosted Satellite's own
  screen is its host's, opened at its section.
- **The `section` action (UI contract 1.2)** opens a Satellite whose manifest says it is a
  section of this one, over it, on both clients, and nothing else. A control for one the client
  can't open is hidden.
- **A generic unlock prompt on Android** (`mobile/src/vault/`): the unlock card, the grant prompt
  of the `secure` action and biometric unlock work for whichever Satellite provides
  `media.vault`. The Locked Folder's own screens use it too.
- `media.vault` gains the optional `keep` operation, and its `biometric` challenge takes `for`.
- **A clickable breadcrumb in File Explorer's folder page**, on both clients: each level of the
  path is a pill that opens that folder, the current one is shown and not pressable, and the
  row scrolls to the end when the path is long. It is **UI contract 1.2's `breadcrumb` block**,
  for any Satellite (`docs/ui-contract.md`).
- **File Explorer opens in its shared interface by default** in Mission Control, as it
  already did in the Android app: browsing, a file's page, management and upload now come from
  its `ui.json` on both clients. Its previous web page stays one switch away in Developer Mode
  until it is retired (`docs/satellites/file_explorer.md`, F6).
- **Uploading files in File Explorer's shared interface**, on both clients: a folder's
  **Upload files** picks one or more files (the browser's file dialog, the phone's document
  picker) and sends them one after another, asking before replacing a file already there and
  reporting each one ("Uploaded 2 of 3 files. Kept the existing notes.txt."). It is **UI
  contract 1.2's `upload` action**, for any Satellite: each file is streamed as the raw body of
  a POST to one of the Satellite's routes, with a `conflict` route for a `409`
  (`docs/ui-contract.md`, `docs/file-explorer-migration.md`, F5).
- **Managing files in File Explorer's shared interface**, on both clients: a folder's page
  creates a folder, renames it and deletes it; a file's page renames and deletes it. A delete
  asks first, and a rename or delete returns to the folder, which reloads. They use the same
  routes and Locked Folder guard as the web page, and a drive's root can be neither renamed nor
  deleted (`docs/file-explorer-migration.md`, F4). The rename route now also answers with the
  renamed entry's folder.
- **A file's page in File Explorer's shared interface**, on both clients: a file's row opens its
  size, date, type and folder, a preview for a picture, and **Open**, **Download** and **Share**.
  Open is **UI contract 1.2's `open` on a download**, for any Satellite: Mission Control opens
  the file in a new tab, the app hands it to whichever app on the phone views that kind of file
  (`docs/file-explorer-migration.md`, F3).
- **Large folders in File Explorer's shared interface**, on both clients: a folder's folders and
  files arrive 200 at a time as you scroll (or with "Show more"), with the folder's totals
  ("250 folders, 10,000 files"); the server reads only the rows it sends. Through **UI contract
  1.2's `more` on a list**, the same paging as a media-grid's: any Satellite's long list can use
  it (docs/file-explorer-migration.md, F2). On Android such a page is a virtualized list, so
  scrolling through 10,000 files no longer stalls it (F2b).
- **File Explorer on Android**, read-only for now: the locations with their free space and the
  machine's total, then each folder's folders and files, with Up and back. It is File Explorer's
  first shared interface (`ui.json`, UI contract 1.2), drawn by the app's shared screen with no
  app change. Mission Control keeps File Explorer's own page by default and offers the shared one
  in Developer Mode while it catches up (`docs/file-explorer-migration.md`, F1).
- **Group Photos' Library by camera, or not at all**, on both clients, as Photo's own web page
  did: a "Group by" choice (Month, Camera, All) above the grid. Only Photo changed (its
  `gallery?group=` and `ui.json`). **UI contract 1.2's offline pages** may now depend on a
  choice's state - the app keeps one copy per value, so the Library stays available offline in
  every grouping - but still never on a search's text.
- **Swipe between photos in the shared web viewer** on a touch screen (a phone's or a tablet's
  browser), as Photo's own page did: a deliberate one-finger sideways swipe; a tap, a scroll or
  a pinch moves nothing, and a swipe on a video stays the player's.
- **Download and share a photo or video** from every viewer of Photos' shared interface, on
  both clients: the file itself, fetched with your session. The web saves it, and shares it
  where the browser can share files; the app saves it to Downloads (Android 10 and later) or
  opens the share sheet with the file. Photo's own Android viewer now shares the file too,
  instead of a link nobody else could open. Through **UI contract 1.2's `download` and `share`
  actions** (one file at a time) and a viewer limit of 8 actions instead of 6.
- **A heart on each photo in Photos' shared interface** (Library, Search, an album), on both
  clients: tap it to add a favourite, and the filled heart shows and removes one, as Photo's
  own screens did. Through **UI contract 1.2's tile quick actions** (`quick`): up to 2 entries
  shaped like the viewer's actions, the first visible one drawn in the tile's corner.
- **The Locked Folder is a folder in Photos' Albums**, with a lock for its cover, right after
  Favorites, on both clients; it replaces the button below the albums and still opens the
  Locked Folder's own screens behind its PIN. Photo adds the tile only while a `media.vault`
  provider is there, and says nothing about what it holds.
- **UI contract 1.2: tile icons and per-item tile actions.** A media-grid item's `icon` (from
  the shared set) is drawn when it has no image, and `open` gives a tile the first of up to 4
  `{action, visible}` entries that holds for its item, skipping one the client can't run there.
- **UI contract 1.0** (`docs/ui-contract.md`). A Satellite can describe its interface in a
  `ui.json`, using pages, navigation and 11 blocks bound to its own routes' data, and get a
  page in Mission Control and a screen in the Android app with no client code of its own.
  Each client renders it with its own components; neither runs code it receives.
- **Satellite capabilities.** A Satellite declares what it offers others under `[provides]`.
  File Explorer provides `files.browse`, used by the shared `file-browser` block and by
  Mission Control's folder picker, which no longer looks for File Explorer by name.
- **Catalog and rediscovery.**
  - `GET /api/catalog` lists every capability's providers.
  - `GET /api/satellites` adds `catalog_revision` and, for each Satellite, `icon_name`,
    `provides` and `ui`.
  - `GET /api/satellites/<name>/ui` serves the document with an ETag.
  - A **Rediscover** button (`POST /api/catalog/rediscover`) re-reads that metadata from disk
    without loading code; a new Satellite folder is reported and loads at the next restart.
- **Icons on Android** come from each Satellite's `icon_name` (shared icon set).
- **Shared contract tests** (`contracts/ui/`): the Engine, Mission Control and the Android app
  check the same vocabulary and fixtures. `test_client_modularity.py` fails when generic
  client code names a Satellite.
- **Showcase** example Satellite (`examples/satellites/native/showcase/`), using every block.
- **UI contract 1.1** - only additions, so every 1.0 document still works:
  - blocks `chart` (time series, or bars), `table`, `choice` (a segmented control over page
    state), `status` (a dot and a word) and `code` (JSON, with Copy);
  - `detail` on fields and metrics, `trend` (a sparkline) and `action` on metrics, `tone` on
    list items, the `eyebrow` text style;
  - page `state`, named `sources` and the `dashboard` template; a document `header`;
    developer-only navigation;
  - `widgets`, summaries a client shows on Home;
  - formats `bitrate`, `byterate`, `time`, `date`, `datetime` and `relative`, and the same
    formatting in the Engine (`format_value`) for Satellites that build text;
  - a 1.0 document that uses a 1.1 feature is refused, so it always declares what it needs.
- **Status is drawn by the shared renderers.** Its interface is now `ui.json` (with a `view`
  route that shapes its snapshot for display) on Mission Control and Android, at parity with
  its previous screens - see "Status's migration" in `docs/satellites/status.md`. Its previous
  page and screen remain for one release: in Developer Mode on the web, and for servers older
  than this one on Android.
- **`audio.library` capability (v1).** Music provides it from its existing routes, so any client
  or Satellite can find an audio library through `GET /api/catalog` without naming Music. A
  capability may now have optional operations, and an operation its version doesn't define is
  refused. The reserved client capability `media.audio-playback` is now `media.audio`. See
  `docs/media-audio.md`.
- **Android: one shared audio player.** The player, its queue, effects, downloads, Connect and
  the floating player UI moved to `mobile/src/media/` (the AudioHost). It plays from the
  catalog's `audio.library` provider, with Music's routes as the fallback on older servers.
  Music also declares `audio.session`, its queue, history, radio, preferences, likes and
  Connect. Nothing about playback changes for listeners.
- **`audio.session` capability (v1).** The playback session beside an audio library is now in
  the shared vocabulary: `queue` is required; `history`, `radio`, `preferences`, `favorites`,
  `stream` and `connect` are optional, and the Engine checks declarations like any other.
  The Android player sends nothing for an operation a provider doesn't offer.
- **Mission Control: one shared audio player.** The player, its queue, effects, Media Session,
  Connect, the floating bar and the top-bar disc moved to `mission_control/media/`, started by the
  shell after sign-in. It plays from the catalog's `audio.library` provider, so the bar, disc and
  saved queue are there on every page and after a reload, before Music's page is opened. Music's
  page keeps its library views and adds its track menu and links to the player.
- **UI contract 1.2: the `play` action.** `{"play": {"search": ...}}` plays what the catalog's
  `audio.library` provider finds, through the client's audio host. Both clients now offer the
  `media.audio` client capability, so any Satellite can play audio without naming the one that
  provides it.
- **Scalable media gallery: server paging and Android virtualization.** A media-grid can page
  through its provider (`more`, with the provider's own cursor): one page at a time, stale pages
  dropped, loading and error states with retry, a refresh that reloads as many pages as were
  loaded, and a selection and viewer that work across pages. On Android a grid that is a page's
  main content is now a virtualized list (memory measured flat at about 130-200 MB while
  scrolling through thousands of items on the emulator); the web draws the grid in chunks the
  browser skips off screen. A map can load what is on screen (`viewport`), with the provider's
  own clusters. Photo's lists take `limit` and `cursor` (stable keyset paging; without them they
  answer everything, as before), its map answers by area with bounded clusters, and its
  `media.gallery` list pages for the picker.
- **UI contract 1.2: `search` and `map` blocks.** A search field bound to page state (results
  reload as the person types, and the field keeps its focus), and located items on an
  interactive map with clusters that stay a handful of markers for thousands of items, opening
  the shared viewer. Each client draws the map it already had (Leaflet and OpenStreetMap on the
  web, react-native-maps on Android): no new map service or key.
- **Photo's shared Search and Map (preview).** Photo's `ui.json` adds Search (file name, camera,
  lens, date and album names, with a Photos/Videos filter) and Map pages, bound to new
  read-only `gallery/search` and `gallery/map` routes. Photo's own page and screens remain the
  default.
- **A reusable media picker (UI contract 1.2's `pick` action).** Any interface can let a
  person choose images or videos, one or several, from whichever Satellite provides the new
  `media.gallery` capability, through the client's picker (`media.picker`, on both clients:
  the shared media-grid with confirm and cancel). The route gets references with the
  provider's identity, never paths. Photo provides `media.gallery` (its active library only,
  never the recycle bin or the Locked Folder), and its shared Album page's "Add photos" uses
  the picker.
- **UI contract 1.2: the `media-grid` block and a shared media viewer.** A grid of images and
  videos from a Satellite's own routes: groups, responsive columns, 60 tiles at a time as it
  scrolls, video badges, loading and error states, a selection with the document's actions,
  and a full-screen viewer (image, video playback, details, actions). Drawn by both clients'
  shared renderers; nothing in it is specific to Photo.
- **UI contract 1.2: preview documents.** `"preview": true` keeps a Satellite's own page or
  screen as the default and offers the shared interface in Developer Mode, while a migration
  reaches parity.
- **Photo's shared Library and Albums (preview).** Photo's new `ui.json` draws its library,
  albums, album pages and recycle bin with the shared gallery, bound to new read-only
  `gallery` routes. Photo's own page and screens remain the default; search, map, import,
  sync, settings and the Locked Folder stay there.
- **UI contract 1.2: `image` and `media-list` blocks.** Images from a Satellite's own routes,
  loaded with the client's session, with sizes, shapes, a loading placeholder and an error
  state; and rows with a thumbnail, title, subtitle, metadata and any action. Drawn by both
  clients' shared renderers; no Satellite uses them yet.
- **Home widgets.** Home on both clients draws every Satellite's widgets; neither names Status
  any more (the Android app keeps its Status card for older servers).
- Mission Control's charts, meters and sparklines, and the app's column chart, meter, bars and
  sparkline, are shared components now (`mission_control/ui/charts.js`,
  `mobile/src/components/charts.tsx`).

### Changed

- **Older interfaces removed.** StarCore now runs only on the latest version, so the code kept
  for older servers and the Alpha app is gone: the `mobile` Satellite route and its
  `mobile_ui` flag, the app's fallback icons and assumed audio provider, and Status's own web
  page, Android screen and Home card (its `ui.json` is its only interface, on both clients).
  An older app no longer works with this server, and this app no longer works with an older one.
- **Favorites is pinned at the top of Folders** in Photos' shared Albums page, on both clients,
  instead of sitting in a group of its own. Only Photo's server changed (`gallery/albums`).
- **UI contract 1.2: offline pages.** A page with `"offline": true` is kept by the Android app
  to show while StarCore can't be reached: its data and the first pages its media-grid loaded,
  per server, session, Satellite and collection, with the usual offline notice, and live again
  as soon as StarCore answers. Bounded (12 collections per server, 512 KB each, 7 days), never
  holding a token, URL or image, and forgotten after any action on the Satellite, on a 401/403,
  on sign-in, sign-out and server removal. Photos' shared Library, Albums and album pages use
  it; Photo's own screens forget it when they delete a photo or move one to the Locked Folder.
  Mission Control keeps nothing.
- **UI contract 1.2: the `secure` action.** In a media viewer's or selection's actions,
  `{"secure": {"capability": "media.vault", "operation": "move_in"}, "item": "$.id"}` runs one
  protected operation on the items, behind the client's own unlock prompt, as one request for a
  whole selection. Only the operations the vocabulary's `secure_operations` lists are allowed
  (so far `media.vault` / `move_in`), only on the document Satellite's own `media.gallery`
  items (the Engine now validates a document against its Satellite's `[provides]`), and with no
  route, prompt or PIN field of the document's own. Contract fixtures cover each rule.
  Mission Control draws it (`mission_control/ui/secure.js`): its own PIN prompt asks for a
  single-use grant for exactly the items, one prompt and one request for a whole selection,
  partial results reported as partial, and the control hidden when no provider can run it.
  The Android app draws it too (`mobile/src/satellites/ui/secure.ts`): the composition root
  registers the Locked Folder's own unlock screen as the prompt for `media.vault`, so the PIN and
  fingerprint unlock ask for a grant instead of opening the vault; what moved is forgotten from
  every session's offline copies and evicted from the image cache. Photos' shared interface
  offers "Move to Locked Folder" in the viewer (Library, Search, Map, an album) and on a
  selection (Library, an album).
- **Photos opens in its shared interface by default** (M6 of the Photos parity audit). Its
  `ui.json` is no longer a preview, so Mission Control and the Android app draw Photos with the
  shared blocks. Photo's own page and screens stay until it is validated: in Developer Mode on
  the web (the button beside the title) and in the app ("Own screen (previous)" on Photo's card in
  Satellites, the reverse of the preview's pill), and for the released Alpha app, which ignores
  the document. `#/satellite/Photo/LockedFolder` keeps opening Photo's own page.
- **Moving into the Locked Folder without opening it (server).** An unlock can ask for a
  single-use grant for one move instead (`for: {operation: "move_in", items}`): bound to the
  session, the exact items and 60 seconds, used up by the first `move_in` whatever its outcome,
  and never an unlock, so the vault stays locked and nothing needs locking again. `move_in`
  takes references (`{provider, capability, id}`), which the Engine resolves through the
  `media.gallery` provider it knows (`starcore/capabilities.py`) and checks again at the moment
  of each move. Photo's `media.gallery` gains an optional `resolve` operation, and the Locked
  Folder provides `media.vault`, with no operation that lists or reads the vault. Photo's library
  now refuses to remove a binned photo for a move, under one lock with binning and restoring.
- **Offline pages keep only what they show.** The app keeps only the fields a page's blocks
  bind, and never a field the page names in `"offline": {"omit": [...]}`, at any depth. Photo
  omits each item's GPS location and its folder on the server, which the first version kept in
  the phone's unencrypted app storage. That store (`starcore_ui_offline:v1`) is removed when the
  app starts, for every server; the new one is `v2`.
- **The shared media viewer zooms, and media-grids take the person's own size.** On Android an
  image in the viewer pinches to zoom and, zoomed, pans with one finger or zooms back on a
  double tap, without taking the swipe between items; it is Photo's own zoomable image, now
  shared (Photo's viewer keeps its two-finger pan). A media-grid's thumbnail size changes with a
  pinch on Android (Photo's own pinch, now shared) and a small, medium and large pill on the
  web, remembered per server, Satellite and grid, keeping the scroll position, selection and
  paging. No contract change. On Android a grid that reaches its end while a page is arriving
  now asks for the next one at once, instead of waiting for the next scroll.
- **UI contract 1.2: the `own` action** opens a Satellite's own interface (its `page.js`, its
  native screens) at a section it names, from the shared interface - the bridge to what stays
  native during a migration. It reaches no route; a client without an own interface hides it,
  and Back returns to the shared interface. Photos' shared Albums page used it for "Settings
  and phone sync" and "Locked Folder", which opened Photo's own screens with their PIN and
  permissions unchanged, until P1, L8 and S0 replaced or removed them. `#/satellite/Photo/LockedFolder` keeps opening Photo's own page while
  Developer Mode shows the shared interface.
- **Photos' shared interface (preview) moves closer to parity**: an "Import from a folder" page
  (check a server folder, then import it, through the existing `scan` and `import` routes, which
  now also answer with a readable `message`), the days each item has left in the recycle bin,
  and albums in their own order instead of newest first. Photo's own page and screens are
  unchanged and remain the default.
- The shared renderers no longer call a page "offline" or "not answering" when StarCore answered
  with an error: the Android notice says "Not refreshed" and the web one "This page could not be
  refreshed", keeping "Offline" for when StarCore can't be reached.
- Mission Control's files and Satellite assets are served `no-cache` with an ETag (revalidated)
  instead of `no-store`.
- The Android Satellites list refreshes when you return to it.
- A Satellite with both a `ui.json` and a `page.js` gets the shared interface on the web; its
  `page.js` is the fallback, and Developer Mode can switch between them.
- The shared renderers pause while a browser tab is hidden or the app is in the background,
  keep the last data (dimmed, with its age) when a refresh fails, and offer a retry when the
  first one does.

### Fixed

- **A web page or drawing opened from a Satellite can no longer act as you.** An HTML, SVG or
  XML file opened in a browser tab (File Explorer's Open) ran on Mission Control's own origin,
  with the session. The Engine now sends such files sandboxed, and never lets a browser guess a
  file's type (`docs/api.md`).
- **File Explorer lists large folders about 13 times faster.** A folder of 10,000 entries took
  about 6 seconds on Windows: each entry was read from disk three times and the Locked
  Folder's path resolved again for it. It now reads the folder once (`os.scandir`) and resolves
  that path once per listing (about 0.4 s); what a listing returns is unchanged.
- **Shared pages of photos or a map use the screen's width on the web.** Every shared page
  except a dashboard was held to 880 px, so Photos filled half of a 16:9 screen. A page with a
  media grid or a map now spreads it across the page, as wide as Photo's own page; its text,
  forms and buttons keep the reading width. No document needs to change.
- **The shared viewer on the web shows the whole photo.** A photo taller than the screen
  (a phone's portrait shot on a 16:9 monitor, say) kept its own height and was cropped by the
  viewer's frame; it is now fitted inside it, whatever its shape.
- **A media-grid selection on the web no longer acts on items from a cancelled selection.**
  Cancelling kept the cancelled items in the selection's memory, so the next selection's action
  (Move to bin, say) also ran on them. A selection's action now acts only on what is selected.
- **The Locked Folder locks again after a failed move from Photos on the web.** A move that
  failed after the PIN (encryption running, a full disk) left that browser session unlocked
  until the time limit; it now locks again whatever the outcome, and a lock that can't be sent
  says when the vault locks by itself instead of reporting success.
- On Android, a Satellite screen's notices now appear above the floating player instead of
  behind it.
- Mission Control's "Sleep timer: end of this track" now stops playback when the track ends,
  also with gapless playback or a crossfade, which used to move straight into the next track.
  While it is set, no next track is lined up.

## 0.1.0-alpha.1 - unreleased

The first Alpha: a stable, reproducible checkpoint of the Engine, Mission Control, the native
Satellites and the Android app, deployed on a Linux server behind HTTPS. It is for testing by
the people running it, not a feature-complete 1.0 - see "Known limitations" in
`docs/releases/v0.1.0-alpha.1.md`.

### Included

- **Engine** - Satellite discovery and lifecycle, TOML configuration with automatic defaults,
  the typed CLI (interactive, and one-shot against a running StarCore), Mission Control's API,
  single-administrator authentication with 7-day sessions.
- **Mission Control** - the StarCore design language across Home, Satellites, Configuration
  and every Satellite page; Developer Mode as a visibility preference.
- **Satellites** - Music (library, playback, queue, playlists, Connect between devices),
  Photo (library, albums, favorites, map, thumbnails, phone backup), Locked Folder (PIN,
  encryption at rest, persistent lockouts, recovery key), File Explorer, Status (health and
  history) and the Docker link Satellite.
- **Android app** - multiple servers, sign-in with optional biometric unlock, Home, Satellites,
  Music, Photos with Locked Folder, Status, Developer Mode.
- **Linux deployment** - `deploy/linux/install.sh`, a hardened systemd unit and the nginx
  HTTPS site (`docs/deployment.md`, "Linux server (systemd)").

### Added in this release

- One version source: the top-level `VERSION` file, read by the Engine at runtime and by the
  Android build. Build number, commit and date come from Git; nothing is hard-coded.
- About sections with version, channel, build, commit and build date: Mission Control
  (Configuration > About, plus a version label at the bottom of the sidebar) and Android
  (Settings > About, showing the app and the connected Engine separately, plus a version line
  at the bottom of Settings). Both have **Copy build info** for bug reports.
- The Engine logs its version at startup: `StarCore 0.1.0-alpha.1 (alpha, build N, <sha>)`.
- Signed, standalone release APK (`mobile/scripts/build-release.ps1`): JS bundle embedded,
  signed with a release key kept outside the repository, verified with `apksigner`,
  `versionCode` derived from the version so updates install in order.
- Release, signing, backup and rollback documentation (`docs/releasing.md`).

### Security

- **A fresh install can no longer be claimed through a reverse proxy or from the LAN.**
  Before the administrator exists, the API answers only a direct client on the server itself;
  everyone else sees just the setup screen, which requires a one-time setup code printed in
  StarCore's startup output. Guesses are throttled.
- **Sign-in throttling is per real client behind the proxy.** It uses the `X-Real-IP` nginx
  sets (believed only from the same machine), so one client's failed guesses can no longer
  lock everyone out.
- The CLI bridge (`/api/cli/run`) refuses any request a proxy forwarded, in addition to nginx
  blocking every `/api/cli` path variant.
- nginx site: 2 GB uploads, unbuffered streaming, `Secure` session cookie, HSTS.

### Changed

- The Android app assumes `https://` for a public host name typed without a scheme (a LAN
  address, `localhost` or `host:port` still defaults to `http://`).
