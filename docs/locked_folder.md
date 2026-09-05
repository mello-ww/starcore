# Locked Folder

The Locked Folder Satellite (`satellites/native/locked_folder/`) is a single protected
storage location, PIN-guarded on the server, that the existing File Explorer Satellite
already knows how to browse - not a second file-browsing feature, and not a second
authentication system.

It also lays the groundwork a future StarCore mobile application will need: a uniform way
for any client, desktop or phone, to prove it may reach the Locked Folder's contents,
without inventing a second server-side security mechanism for mobile. See "Mobile
authentication" below for the full design.

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
GET  /api/satellites/LockedFolder/status                      -> { "configured": bool, "pin_set": bool, "unlocked": bool, "expires_at": str|null }
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
`max_pin_attempts` (default 5) consecutive failures, that session's PIN attempts - unlock
*and* the "current PIN" check when changing the PIN, since guessing one is exactly as useful
an attack as guessing the other - are locked out for `lockout_seconds` (default 300), even a
correct PIN refused until the lockout expires. This is scoped per session, not per account or
per IP: reaching a Locked Folder route at all already requires a valid, authenticated
StarCore session (see "Authentication" in `docs/api.md`), so the realistic threat here is a
stolen or shared session guessing at the PIN, not an anonymous caller - rate-limiting by
session token addresses exactly that, and correctly does not penalize a different, unrelated
session for the same account.

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
- invalidates every existing unlock, for every session, the same as any other change to the
  configured path already does (see "Unlock design" above);
- clears every session's brute-force attempt/lockout counters too, since a lockout earned
  against a configuration that no longer exists has nothing left to protect;
- leaves the PIN itself untouched - delinking removes the *location*, not the *credential*,
  so a PIN already set keeps working once a new location is configured. Change or clear the
  PIN separately (`POST /pin`) if that's what's actually wanted.

`400` if nothing is configured to delink in the first place; otherwise `200` with
`{"delinked": true}`. Mission Control's Locked Folder page offers this as a "Delink
Locked Folder" button, shown whenever a location is configured (not only when its directory
is missing), with a confirmation prompt before it runs since - unlike locking - it can't be
undone by simply unlocking again: a new location has to be configured afterward.

## Mission Control

The Locked Folder's own Mission Control page shows its status (configured or not, PIN set or
not, locked or unlocked, and when an unlock expires), a form to set or change the PIN, an
unlock dialog, and a lock button once unlocked - matching the rest of Mission Control's
visual language, not a redesign of it. A configured directory that no longer exists on disk
(see "The configured directory can disappear" above) shows a distinct "missing" badge and a
plain-language explanation, right alongside the "Delink Locked Folder" button that's always
present once a location is configured. Once unlocked, the same page also renders an embedded
file browser confined to the vault, built entirely on File Explorer's existing `entries`,
`content`, `upload`, `mkdir`, `rename` and `delete` routes (called directly, the same way any
other client would) rather than a second, satellite-specific browsing implementation - it
simply never lets navigation go above the configured root.

Separately, File Explorer's own page now draws a small lock badge next to any entry the
Locked Folder reports as `"locked": true`, and refuses to enter it - with the same clear
"unlock it from the Locked Folder page first" message the API itself returns - until it has
been unlocked from there.

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

## Mobile authentication

A future StarCore mobile app authenticates with the device's native biometrics - Face ID,
Touch ID, or Android's Biometric API - but StarCore itself never implements, receives, or
stores anything biometric. The design keeps exactly one server-side mechanism doing the
actual work on both platforms:

- **On PC**, a person types the PIN into Mission Control's unlock dialog, which calls
  `POST /unlock` with it.
- **On a future phone app**, the PIN is stored in the OS's own secure storage (Keychain on
  iOS, Keystore on Android) and released locally, on the device, only after a successful
  local Face ID/Touch ID/biometric check - then submitted to the *exact same*
  `POST /unlock` endpoint.

Biometrics gate local release of a secret that already exists (the PIN); they are never sent
anywhere, and the server-side unlock code path is identical regardless of which kind of
client called it. This is why no second unlock mechanism, no biometric-specific endpoint, and
no biometric data format appear anywhere in this Satellite or in `starcore/auth.py`.

Separately, from "Authentication" in `docs/api.md`: `POST /api/auth/login` already accepts an
optional `kind` (`"web"` or `"mobile"`) and `device_name`, so a future mobile app establishes
its StarCore session through the exact same login endpoint every other client uses - not a
second session mechanism - just labeled so it can be told apart later. `GET
/api/auth/sessions` and `POST /api/auth/sessions/revoke` (also documented in `docs/api.md`)
are how a mobile device's session is listed and can be securely revoked - from Mission
Control's "Active sessions" panel today, and from a future in-app "manage devices" screen
later, both reaching the same server-side session store.

### The two flows in full

**Phone:** local biometric authentication (Face ID/Touch ID/Android Biometrics, entirely on
the device) unlocks local access to a securely stored device credential (the PIN, released
only after that local biometric check) → the app uses StarCore's ordinary authentication/
session API (`POST /api/auth/login`, labeled `"kind": "mobile"`) to establish a normal
StarCore session → that session calls `POST /api/satellites/LockedFolder/unlock` with the
released PIN → the server, exactly as it does for any other client, checks the PIN and marks
that session unlocked.

**PC:** a person authenticates to StarCore itself (`POST /api/auth/login`, a normal `"web"`
session) → Mission Control's unlock dialog collects the PIN and calls
`POST /api/satellites/LockedFolder/unlock` → the server checks it and marks that session
unlocked.

Both flows converge on the same two server-side checks - a valid StarCore session, then a
correct PIN for that session - and nothing about the Locked Folder's authorization logic
needs to know or care which kind of client it's talking to. Biometrics never leave the
device, StarCore never receives or stores anything biometric, and the backend remains the
single source of truth for whether the Locked Folder is actually unlocked, regardless of
which client is asking.

This block deliberately stops at these foundations - the API, session labeling, and PIN-based
unlock a mobile app would call into. It does not build the mobile application itself.

## Cross-satellite reference: how File Explorer finds the Locked Folder

File Explorer needs to ask "is this path protected, and is it unlocked for this caller?"
without a hardcoded Python import of another Satellite's package (fragile the moment a
directory is renamed). It does this the same way the existing FileExplorer directory-picker
integration works in reverse (see "Exposing configuration" in `docs/satellites.md`): a lookup
by manifest name, `engine.registry.get("LockedFolder")`, combined with a live runtime object
the Locked Folder Satellite stashes on itself as a plain attribute
(`satellite.locked_folder_runtime`, set inside `runtime.py`'s `runtime(satellite)` factory,
and kept warm by its `state.py`, which the Core already calls whenever a Satellite's state is
queried). File Explorer's guard reads that attribute defensively
(`getattr(satellite, "locked_folder_runtime", None)`) and simply protects nothing if the
Locked Folder Satellite is absent, disabled, or hasn't initialized yet - never an error, just
"nothing to guard here."

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
