# Locked Folder

The Locked Folder Satellite (`satellites/native/locked_folder/`) is a single protected
storage location, PIN-guarded on the server, that the existing File Explorer Satellite
already knows how to browse - not a second file-browsing feature, and not a second
authentication system.

People reach it as the **Locked Folder tab of Photos**, on the web and in the Android app -
it has no navigation entry of its own (`section_of = "Photo"` in its `satellite.toml`; see
"Satellite manifest" in `docs/satellites.md`). That is presentation only: the Locked Folder
keeps its own data, PIN and routes, separate from Photo's, and every route checks the
caller's session and unlock on the server. Hiding a navigation entry is never what keeps it
private. Old links to `#/satellite/LockedFolder` open the Photos tab.

## What it protects, and how

A single configurable path (`locked_folder_path` - see "Configuration" below) is the Locked
Folder's protected root. Nothing about protecting it is special-cased inside File Explorer's
storage or listing code: every one of File Explorer's routes that touches a real path
(`entries`, `content`, `upload`, `mkdir`, `rename`, `delete`) resolves the request's path the
same way it always has, then asks a small guard - `locked_folder_guard.guard(request,
target)` in `satellites/native/file_explorer/locked_folder_guard.py` - whether that resolved
path falls inside the configured root and, if so, whether the caller's session has unlocked
it. A `403` comes back if not; otherwise the route runs exactly as it would for anywhere
else on disk.

This is deliberate on two counts:

- **The server enforces it, not the frontend.** The guard runs inside the same handler that
  would otherwise serve the file, using the resolved, symlink-followed real path
  (`paths.resolve_path()` - see `docs/satellites.md`/File Explorer's own documentation for
  what that guarantees), so a request that reaches File Explorer's API directly - never
  touching Mission Control's UI at all - is refused exactly the same way a browser would be.
  There is no client-side check anywhere that "hides" the Locked Folder; a locked vault is
  invisible-inside but never secretly reachable.
- **File Explorer gains nothing it didn't already have.** No new file-handling code exists
  anywhere for the vault's contents - listing, reading, writing, renaming and deleting a file
  inside the Locked Folder once unlocked are the exact same code paths as anywhere else File
  Explorer can reach. Locked Folder's own Mission Control page (see "Mission Control" below)
  is a thin, root-confined view built entirely on File Explorer's existing routes.

`entries()` also flags every item that falls inside the configured root with `"locked":
true` in its listing - a visibility hint only (so File Explorer can draw a lock badge next
to the Locked Folder), never itself what keeps the contents inaccessible; the guard above is
what does that, independent of anything the frontend chooses to render.

## PC authentication - the PIN

A single PIN (4-12 digits, `validate_pin()` in `runtime.py`) unlocks the Locked Folder for
the caller's current session.

```
GET  /api/satellites/LockedFolder/status                      -> { "configured", "pin_set", "pin_unreadable", "unlocked", "expires_at", "biometric_devices", ... }
POST /api/satellites/LockedFolder/pin      { "pin": "...", "current_pin": "..." }  -> set or change the PIN
POST /api/satellites/LockedFolder/unlock   { "pin": "..." }                       -> unlock this session
POST /api/satellites/LockedFolder/lock     {}                                     -> lock this session immediately
```

The PIN is hashed with the exact same function the core authentication system already uses
for the administrator's password - `hash_secret()` in `starcore/auth.py`, PBKDF2-HMAC-SHA256
at 260,000 iterations with a random per-PIN salt (see "Authentication" in `docs/api.md`) -
rather than a second hashing implementation living inside this Satellite. The hash and salt
are the only things ever written to disk (`pin.json`, atomic `.part` + rename, the same
convention every other Satellite's index files use); the plaintext PIN is never stored,
logged, or included in any API response.

The format of `pin.json` (`{"salt": <hex>, "hash": <hex>}`) is unchanged from the first
release, so an existing PIN keeps working as is. A `pin.json` that exists but can't be read
is treated as **set but unusable** (`"pin_unreadable": true`): unlocking and setting a new PIN
are refused with `409` until an administrator repairs or removes the file on the server.
Before, an unreadable file read as "no PIN yet", which would have let anyone signed in set a
new one and open the vault.

By default, `pin.json` lives under StarCore's application-data directory, not inside the Git
checkout - see "Runtime data location" in `docs/deployment.md` for exactly where, and how an
existing installation's PIN is migrated there automatically.

Unlock state itself is **never persisted to disk at all** - it lives only in memory, keyed by
session token, for as long as the process runs. Two things fall out of this on purpose: a
StarCore restart always re-locks everything, with no on-disk "was unlocked" flag to leak or
go stale; and a session token - already sensitive enough that it is never written to disk a
second time - never has to be.

Unlocking marks *the calling session's token*, not the account as a whole, unlocked for
`session_timeout_seconds` (configurable, default 900 = 15 minutes); a second, independent
session for the same administrator account is unaffected either way, and locking explicitly
(`POST /lock`) revokes only the caller's own session immediately. Changing the PIN
(`POST /pin` with a new `pin` and, if one is already set, the matching `current_pin`)
revokes every existing unlock across every session at once, since a PIN that just changed
should not leave an old unlock quietly valid under the new one.

An incorrect PIN, an unconfigured vault, or an unset PIN are all reported as distinct,
specific errors (`400` for "nothing is configured yet" or "no PIN is set yet", `401` for a
wrong PIN, `429` with a `retry_after` in seconds while rate-limited) - never a generic
failure - so Mission Control's unlock dialog can show the caller exactly what's wrong.

### Brute-force protection

Repeated incorrect PIN attempts against the same session are rate-limited: after
`max_pin_attempts` (default 5) consecutive failures, that session's attempts - unlock, the
"current PIN" check when changing the PIN, biometric enrollment, and a failed biometric
signature - are locked out for `lockout_seconds` (default 300), even a correct PIN refused
until the lockout expires.

Signing in again gives a fresh session, so an **account-wide backstop** sits on top: after
`max_pin_attempts × 4` failures from any mix of sessions with no correct PIN in between,
every session is refused for `lockout_seconds`, doubling with each further lockout up to 24
hours. A correct PIN resets both counters.

Each attempt is counted as a failure the moment it starts and only cleared by a correct PIN,
so firing many guesses at once while the slow PIN hash runs can't get past the limit. The
counters are in memory, like the unlock state, so a restart clears them.

### Settings that need the PIN

Once a PIN guards a configured vault, the settings that could point the protection elsewhere
or loosen it - `locked_folder_path`, `max_pin_attempts`, `lockout_seconds`,
`session_timeout_seconds` - and `POST /delink` all need **this session unlocked** (`403`
otherwise). Without this, anyone signed in could repoint or delink the Locked Folder and read
the old vault through File Explorer without the PIN, or reset a brute-force lockout by
delinking and relinking. Before a PIN is set, they can be changed freely, since there is
nothing to protect yet. Someone who forgets the PIN has to edit `config.toml` on the server.

### The configured directory can disappear

The configured location is a normal directory on disk, and normal filesystem permissions
still apply to it (see "What it protects, and how" above) - which means it can be deleted or
moved from outside StarCore entirely: Windows File Explorer, `rm -rf`, a script, another
program. `GET /status` reports this distinctly rather than pretending everything is still
fine: `"path_exists"` is `true` when the configured path is there, `false` when it no longer
is, and `null` only when nothing is configured at all. StarCore never recreates a directory
that disappeared this way, and nothing here crashes over it - the same routes that would
normally serve its contents simply report the same `404` File Explorer already gives for any
other path that isn't there.

### Delinking

`POST /delink` removes the Locked Folder's association with its configured directory,
without touching that directory (or anything in it) on disk in any way - the fix for exactly
the situation above, where a directory is gone but Mission Control would otherwise keep
reporting it as configured and protected forever, with no way to move on from it. It:

- clears `locked_folder_path` back to empty (the same effect as configuring it to `""`
  through the generic Satellite configuration route - `delink` is a thin, named wrapper
  around that exact call, not a second mechanism);
- needs this session unlocked once a PIN is set (see "Settings that need the PIN");
- invalidates every existing unlock, for every session, the same as any other change to the
  configured path already does;
- leaves the PIN itself untouched - delinking removes the *location*, not the *credential*,
  so a PIN already set keeps working once a new location is configured. Change or clear the
  PIN separately (`POST /pin`) if that's what's actually wanted.

`400` if nothing is configured to delink in the first place; otherwise `200` with
`{"delinked": true}`. The Locked Folder tab offers this as "Delink this folder" in its
settings, with a confirmation prompt before it runs since - unlike locking - it can't be
undone by simply unlocking again: a new location has to be configured afterward.

## The vault as media, and moves to and from Photos

```
GET  /api/satellites/LockedFolder/media                         -> { "items": [ {path, name, size, modified, media_type, content_type} ], "truncated" }
GET  /api/satellites/LockedFolder/media/file?path=<relative>    -> the file itself (Cache-Control: private, no-store)
POST /api/satellites/LockedFolder/move_in   { "photo_ids": [...] } -> { "moved": [...], "failed": [...] }
POST /api/satellites/LockedFolder/move_out  { "paths": [...] }     -> { "moved": [...], "failed": [...] }
```

All four need this session unlocked (`403` otherwise). `media` lists every file in the vault,
tagged `photo`, `video` or `file`, skipping hidden files and in-progress copies; paths are
relative to the vault and anything that resolves outside it (`..`, an absolute path, a
symlink out) is refused. Files are served `no-store`, so a browser or the app never keeps a
copy on disk.

**Moving a photo in** copies its original from the Photo library into the vault's `Photos`
folder under a free name (never overwriting), flushes it to disk and checks its SHA-256
against the original before giving it its final name. Only then is the photo removed from the
library (index first, then its stored file and thumbnail) and from every album, Favorites
included. If anything fails before that point the vault copy is removed and the photo stays
exactly where it was; if removing it from the library fails, the vault copy is removed again.

**Moving a file out** imports it into the Photo library through Photo's normal ingestion,
checks the library's copy against the original's SHA-256, and only then deletes the vault
file. A file Photo can't read (a document, say) stays in the vault and is reported in
`failed`. A photo that was sitting in Photo's recycle bin comes back out of it.

### Keeping private media out of Photos

Photo asks the Locked Folder two questions (`satellites/native/photo/private_media.py`),
whether or not the Locked Folder is currently enabled:

- **Is this path inside the vault?** Importing or scanning the vault itself is refused, and
  importing a folder that contains the vault (or links into it) skips the vault's files.
- **Was this file moved in from Photos?** Every move in records the file's SHA-256 (only the
  digest, never a name or path) in `sealed.json` next to `pin.json`. Photo answers such a file
  like a duplicate in a directory import, a phone sync upload and the standalone sync
  listener - so a phone that still has the photo stops re-sending it, and it never reappears
  in the gallery, search, albums, the map or thumbnails. Moving it back out clears the record.

## Biometric unlock

Android phones can unlock with a fingerprint or face, as an option on top of the PIN, never
instead of it. It is separate from the app's own biometric app lock.

```
POST /api/satellites/LockedFolder/biometric/enroll     { "pin", "public_key", "device_name" } -> { "key_id" }
POST /api/satellites/LockedFolder/biometric/challenge  { "key_id" }                           -> { "challenge" }
POST /api/satellites/LockedFolder/biometric/unlock     { "key_id", "challenge", "signature" } -> like /unlock
POST /api/satellites/LockedFolder/biometric/revoke     { "key_id" }                           -> { "revoked": true }
```

- **Turning it on** creates an RSA-2048 key in the phone's Android Keystore that can only sign
  after a strong biometric match (react-native-biometrics). The app sends the public half with
  the **PIN**, which the server checks (and rate-limits) before storing the key in
  `devices.json`, next to `pin.json`.
- **Unlocking** asks the server for a random challenge that belongs to this session, is used
  up by the first attempt and expires after two minutes. The phone signs it behind the
  biometric prompt (SHA256withRSA) and the server verifies the signature against the enrolled
  key before unlocking the session - so a client that merely claims a biometric match gets
  nothing. A wrong signature counts toward the brute-force limits.
- **The PIN is never stored on the phone.** The earlier plan was to keep the PIN in the
  Keystore and release it after a biometric check; a signing key does the same job without a
  copy of the PIN existing anywhere but in the person's head.
- **It turns itself off** when it can no longer be trusted: changing the PIN removes every
  enrolled device on the server, and Android invalidates the key when fingerprints or faces
  are added. Either way the app falls back to the PIN and asks to turn it on again.
- Verification is standard-library only (`signatures.py`, RSASSA-PKCS1-v1_5 per RFC 8017,
  comparing the full expected encoding rather than parsing it). Keys under 2048 bits are
  refused.

## Mission Control and the Android app

**Mission Control:** the Photos page has a "Locked Folder" tab (`#/satellite/Photo/LockedFolder`)
with four states - set up a location, create a PIN, locked (PIN entry with a countdown during
a lockout), and unlocked (a grid of photos and videos, other files listed below, a viewer with
"Move to Photos" and "Delete", upload, and settings for changing the PIN and delinking). A
photo's viewer in Photos has a lock button that moves it in, asking for the PIN first when
needed and locking again straight after. The tab locks again when you switch tabs, leave
Photos, or close or reload the page (a `sendBeacon` to `/lock`), and when the server's time
limit runs out.

**Android:** Photos has a "Locked" section with the same states (a location is chosen from
Mission Control), biometric unlock as above, and a private viewer with "Move to Photos"; a
photo's viewer has "Lock". While the section is open the window is `FLAG_SECURE` (no
screenshots or screen recording, a blank card in recent apps). Vault images are fetched with
the session token and shown from memory, never through the image loader's disk cache. Moving a
photo in also drops it from the app's cached photo list and evicts its gallery thumbnail from
the image cache. The section locks again when it closes, when the app goes to the background,
when the server is switched, and when the server's time limit runs out.

File Explorer's own page still draws a lock badge next to the vault and refuses to enter it
until unlocked.

## Configuration

`satellites/native/locked_folder/config.toml`:

```toml
enabled = true
storage = "data"                # where the PIN hash is kept - see below
locked_folder_path = ""         # empty means "not configured" - nothing is protected yet
session_timeout_seconds = 900   # how long an unlock lasts before the session must PIN in again
max_pin_attempts = 5            # incorrect PINs allowed before a temporary lockout
lockout_seconds = 300           # how long that lockout lasts
```

`storage` is internal, not exposed through the Satellite's own `"configuration"` route below
- the literal default value, `"data"`, means "use StarCore's application-data directory" (see
"Runtime data location" in `docs/deployment.md`), migrating any pre-existing PIN found in the
historical in-checkout location automatically. Anything else - an explicit absolute path, or
an explicit relative one other than `"data"` - is a deliberate override, resolved exactly as
before (relative paths inside this Satellite's own directory), with no migration attempted.

All four editable settings (`locked_folder_path`, `session_timeout_seconds`,
`max_pin_attempts`, `lockout_seconds`) are exposed through the Satellite's own
`"configuration"` route, the same mechanism Photo's `sync_host`/`sync_port` and
`photo_directory` use (see "Exposing configuration" in `docs/satellites.md`) - not a second
configuration system. `locked_folder_path` must be an absolute path (or `~`-prefixed) and may
not be a filesystem root; changing it to a new value revokes every existing unlock, and
clearing it back to empty disables protection entirely (File Explorer then treats that
location as any other).

## Sessions on phones

`POST /api/auth/login` accepts an optional `kind` (`"web"` or `"mobile"`) and `device_name`,
so the app's session is created through the same login endpoint every other client uses,
just labeled so it can be told apart. `GET /api/auth/sessions` and
`POST /api/auth/sessions/revoke` (see `docs/api.md`) list and revoke it. The Locked Folder's
unlock always belongs to one session: a phone's unlock never opens the vault for the browser,
or the other way round.

## Cross-satellite reference: how File Explorer finds the Locked Folder

File Explorer needs to ask "is this path protected, and is it unlocked for this caller?"
without a hardcoded Python import of another Satellite's package (fragile the moment a
directory is renamed). It does this the same way the existing FileExplorer directory-picker
integration works in reverse (see "Exposing configuration" in `docs/satellites.md`): a lookup
by manifest name, `engine.registry.get("LockedFolder")`, combined with a live runtime object
the Locked Folder Satellite stashes on itself as a plain attribute
(`satellite.locked_folder_runtime`, set inside `runtime.py`'s `runtime(satellite)` factory,
and kept warm by its `state.py`, which the Core already calls whenever a Satellite's state is
queried). File Explorer's guard reads that attribute, and when nothing has created the
runtime yet - the first request after a restart - it runs the Locked Folder's state provider
to create it, rather than letting the request through unguarded. Photo's `private_media.py`
does the same. Only an absent or disabled Locked Folder Satellite means "nothing to guard".

Renaming or deleting a folder that **contains** the vault is refused while it is locked too
(`guard_tree()`), since either would move the vault out from under its configured path or
erase it without the PIN.

## Tests

`engine/tests/test_locked_folder.py` covers: the vault being completely inaccessible while
locked (listing, reading, uploading, creating, renaming and deleting all refused); a correct
PIN unlocking and an incorrect one being rejected; the PIN never being stored in plaintext;
an unlock expiring on its own after the configured timeout; locking immediately revoking
access; unlock state being scoped to the session that earned it, never the account as a
whole; brute-force lockout after repeated wrong PINs, scoped the same way; changing the PIN
requiring the current one and revoking every existing unlock; path traversal (`..`) and a
symlink pointing into the vault both being blocked the same as any direct path; and every
route requiring a valid StarCore session in the first place. It also covers the configured
directory disappearing from disk (`status` reporting `path_exists` correctly, never a crash)
and delinking (removing the configured path without touching the directory on disk;
invalidating the active unlock and any brute-force lockout; File Explorer no longer treating
the old path as protected afterward; a new Locked Folder configuring normally afterward, with
the same PIN still working). A separate fixture (`LockedFolderStorageMigrationTest`) covers
the PIN storage default resolving to StarCore's application-data directory, and a PIN from
the historical in-checkout location being migrated there automatically - both with
`STARCORE_DATA_DIR` redirected so neither test can ever touch a real machine's actual data.

`engine/tests/test_locked_folder_security.py` covers the later hardening and the Photos
integration, all on temporary directories: settings and delink needing the vault unlocked;
fresh sessions not resetting the PIN limit; parallel guesses not exceeding it; a wrong
current PIN counting; an existing `pin.json` working unchanged and an unreadable one keeping
the vault locked; the PIN never appearing in responses or stored files; the media and move
routes refusing a locked or missing session and anything outside the vault; `no-store` on
vault files; folders containing the vault protected from rename and delete; the guard working
before anything created the runtime; Photo refusing to import the vault and skipping it
inside a parent folder; moves in removing a photo from the library, albums, thumbnails and
originals; a moved photo not coming back through import or sync; a failed copy, or a failure
after copying, leaving everything where it was; moves out, unreadable files and failed moves
out; and biometric enrollment, signature checks, replayed or foreign challenges, failures
counting toward the limit, PIN changes removing enrollments, revocation and weak keys - with
an RSA test key generated in the test itself.

`engine/tests/test_auth.py` was extended alongside it to cover session `kind`/`device_name`
labeling, `list_sessions()` and `revoke_session()`, and the two new `/api/auth/sessions*`
endpoints - including that they themselves require a session, which they did not until this
block (see "Authentication" in `docs/api.md`).

`engine/tests/test_deployment.py` covers `runtime_paths.data_dir()` (the environment override,
and each platform's default location) and `runtime_paths.migrate_legacy_file()` (an existing
file being moved, a fresh install having nothing to migrate, an existing file at the new
location never being overwritten, and a failed move falling back to the old location without
losing anything) in isolation, plus `StarCore.__init__`'s own wiring of it for the
authentication store specifically. `engine/tests/test_gitignore.py` verifies, against a real
disposable git repository, that the runtime-data and secret paths above are actually ignored
and that ordinary tracked source/configuration files are not.
