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
same way it always has, then asks the Engine - `guard(request, target)` in
`satellites/native/file_explorer/protection.py`, over `starcore.capabilities.protection` -
whether that resolved path is in a protected area and, if so, whether the caller's session
has it open. The Locked Folder answers through the `files.protected` capability (its `check`
route); File Explorer never names it. A `403` comes back if not; otherwise the route runs
exactly as it would for anywhere else on disk. Photo's import and Music's scans ask the same
question (see "Every Satellite asks the Engine" below).

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

`entries()` also flags every item in a protected area with `"locked": true` in its listing -
a visibility hint only (so File Explorer can draw a lock badge next to the Locked Folder),
never itself what keeps the contents inaccessible; the check above is what does that,
independent of anything the frontend chooses to render.

Once the vault is **encrypted** (see "Encryption at rest" below), or while it is being
encrypted, the guard refuses every path inside it even for an unlocked session: there would
be nothing but ciphertext to show, and a file uploaded there would land unencrypted. The
vault is then read and written only through the Locked Folder's own routes.

## PC authentication - the PIN

A single PIN (4-12 digits, `validate_pin()` in `runtime.py`) unlocks the Locked Folder for
the caller's current session.

```
GET  /api/satellites/LockedFolder/status                      -> { "configured", "pin_set", "pin_set_at", "pin_unreadable", "unlocked", "expires_at", "biometric_devices", "security", "encryption", ... }
POST /api/satellites/LockedFolder/pin      { "pin": "...", "current_pin": "..." }  -> set or change the PIN
POST /api/satellites/LockedFolder/unlock   { "pin": "..." }                       -> unlock this session
POST /api/satellites/LockedFolder/lock     {}                                     -> lock this session immediately
POST /api/satellites/LockedFolder/recover  { "recovery_key", "pin" }              -> a new PIN, with the recovery key
```

`status.security` is for whoever administers the server, and never holds a PIN, key or
token: `problem` says why the PIN can't be checked right now (`pin_unreadable`,
`pin_tampered`, `key_unavailable`, `keyring_damaged`, `encryption_unavailable` - see below),
and `lockout` gives `retry_after`, `failed_attempts`, `lockouts` and `state_damaged` for the
account-wide counter. While `problem` is set, unlocking, setting a PIN and biometric unlock
are all refused with `409` (`503` for missing encryption support), so damaged or edited
security state never reads as permission.

The PIN is hashed with the exact same function the core authentication system already uses
for the administrator's password - `hash_secret()` in `starcore/auth.py`, PBKDF2-HMAC-SHA256
at 260,000 iterations with a random per-PIN salt (see "Authentication" in `docs/api.md`) -
rather than a second hashing implementation living inside this Satellite. The hash and salt
are the only things ever written to disk (`pin.json`, atomic `.part` + rename, the same
convention every other Satellite's index files use); the plaintext PIN is never stored,
logged, or included in any API response.

The format of `pin.json` (`{"salt": <hex>, "hash": <hex>}`) is unchanged from the first
release, so an existing PIN keeps working as is. Encrypting the vault adds one optional field,
`"binding"` (see "Security state bound to the vault"); the salt and hash are never changed by
it, and code that predates it simply ignores the field. A `pin.json` that exists but can't be
read is treated as **set but unusable** (`"pin_unreadable": true`): unlocking and setting a
new PIN are refused with `409` until it is repaired, or the PIN is reset with the recovery
key. Before, an unreadable file read as "no PIN yet", which would have let anyone signed in
set a new one and open the vault.

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
so firing many guesses at once while the slow PIN hash runs can't get past the limit.

The counters are **persisted** in `attempts.json`, next to `pin.json`, and written (and
flushed to disk) *before* the PIN is checked - so neither a restart, a reboot, nor a crash
in the middle of a check forgets an attempt or ends a lockout. Sessions appear there only as
a truncated SHA-256 of their token, never the token. Deadlines are wall-clock times, capped
on load at 24 hours from now so a clock that jumped ahead can't stretch a lockout further.
Guarding against permanent lockout from ordinary mistakes:

- a day without a single wrong PIN forgets earlier failures and escalation;
- no lockout is ever longer than 24 hours;
- the recovery key (if one exists) works during a PIN lockout - it has its own counter.

Never treated as permission:

- **a damaged `attempts.json`** locks every session out for one `lockout_seconds` period
  (`state_damaged: true` in `status`), then the counters start over;
- **an attempt that can't be saved** (a full or read-only disk) is refused with `503` before
  the PIN is looked at - an attempt that isn't recorded could be repeated without limit;
- **changing a setting** can't shorten a lockout already recorded, and changing settings needs
  an unlock anyway;
- **every route that checks a PIN or a signature** - unlock, PIN change, biometric enrollment
  and biometric unlock - goes through the same counter. The recovery key has a counter of its
  own with the same limits (no ×4 factor), persisted the same way.

The counters assume one StarCore process per data directory, which is how StarCore runs.

### Settings that need the PIN

Once a PIN guards a configured vault, the settings that could point the protection elsewhere
or loosen it - `locked_folder_path`, `max_pin_attempts`, `lockout_seconds`,
`session_timeout_seconds` - and `POST /delink` all need **this session unlocked** (`403`
otherwise). Without this, anyone signed in could repoint or delink the Locked Folder and read
the old vault through File Explorer without the PIN, or reset a brute-force lockout by
delinking and relinking. Before a PIN is set, they can be changed freely, since there is
nothing to protect yet.

A forgotten PIN can be reset with the **recovery key**, if one was created when the vault
was encrypted (see "Recovery key"). For an unencrypted vault there is no recovery: whoever
administers the server can delete `pin.json` (which then lets anyone signed in set a new PIN),
which is exactly the weakness encryption and its bindings close.

`status.pin_set_at` is when `pin.json` was last written (its file time; the PIN record itself
has no date). The locked screen shows it ("Enter the PIN set for this Locked Folder on …"), so
an existing PIN is never mistaken for a first-time setup that went wrong. Without a recovery
key, "Forgot your PIN?" explains the server-side reset above instead of offering a form.

### The configured directory can disappear

The configured location is a normal directory on disk, and normal filesystem permissions
still apply to it (see "What it protects, and how" above) - which means it can be deleted or
moved from outside StarCore entirely: Windows File Explorer, `rm -rf`, a script, another
program. `GET /status` reports this distinctly rather than pretending everything is still
fine: `"path_exists"` is `true` when the configured path is there, `false` when it no longer
is, and `null` only when nothing is configured at all. `"path"` itself is given only to a
session that has the vault unlocked, or while no PIN guards it yet (during setup); a locked
session gets `null`, and the configuration route leaves the location out of its settings, with
a note to unlock first. StarCore never recreates a directory
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
GET  /api/satellites/LockedFolder/media                         -> { "items": [ {path, name, folder, size, modified, media_type, content_type, encrypted, damaged?} ], "truncated" }
GET  /api/satellites/LockedFolder/media/file?path=<path>        -> the file itself (Cache-Control: private, no-store; Range supported)
POST /api/satellites/LockedFolder/upload?name=&folder=          -> raw body; the new item
POST /api/satellites/LockedFolder/delete    { "paths": [...] }     -> { "deleted": [...], "failed": [...] }
POST /api/satellites/LockedFolder/move_in   { "photo_ids": [...] } -> { "moved": [...], "failed": [...] }
POST /api/satellites/LockedFolder/move_out  { "paths": [...] }     -> { "moved": [...], "failed": [...] }
```

All of them need this session unlocked (`403` otherwise), and the ones that change the vault
are refused (`409`) while it is being encrypted. `media` lists every file in the vault,
tagged `photo`, `video` or `file`, skipping hidden files and in-progress copies. A `path` is
opaque to clients: for an unencrypted file it is relative to the vault, and anything that
resolves outside it (`..`, an absolute path, a symlink out) or into `.starcore-vault` is
refused; for an encrypted file it is `.starcore-vault/objects/<id>.sclf`. Files are served
`no-store`, so a browser or the app never keeps a copy on disk. `delete` is permanent and
only ever removes files. Uploads and deletes used to go through File Explorer; they now go
through these routes, which encrypt on the way in once the vault is encrypted.

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

### Moves from a shared interface: grants and references

The Locked Folder provides the `media.vault` capability: `status`, `unlock`, `lock`, `move_in`
and, optionally, `biometric`. It has no operation that lists or reads the vault; viewing it
stays in its own screens. The design, its security audit and the accepted risks are in
[`archive/m5-locked-folder-actions-audit.md`](../archive/m5-locked-folder-actions-audit.md).

```
POST /api/satellites/LockedFolder/unlock   { "pin", "for": { "operation": "move_in", "items": [reference] } }
                                           -> { "unlocked": false, "grant", "expires_at" }
POST /api/satellites/LockedFolder/move_in  { "items": [reference], "grant"? } -> { "moved": [...], "failed": [...] }
```

- **A reference** is `{"provider", "capability": "media.gallery", "id"}`. It is resolved by
  the Engine through the `media.gallery` provider it knows (see the UI contract's "Shared
  blocks and Satellite capabilities"), never trusted as sent, and only Photo's items can be
  moved in. One reference that doesn't resolve refuses the whole request (`400`, with
  `refused` listing which), so nothing is moved. At most 500 at once.
- **A grant** is what an unlock with `for` returns instead of an unlock. The PIN (or a biometric
  signature, with the same `for`) is checked exactly as for an unlock, with the same attempt
  counting and lockout. A malformed `for` or a bad reference is refused before the attempt is
  counted. The grant:
  - is bound to this session, to `move_in`, and to exactly the resolved items;
  - lasts 60 seconds, in memory only;
  - is used up by the first `move_in` that presents it, whatever its outcome. Taking it out and
    checking it are one step under a lock, so of two requests only one finds it, and a replay
    finds nothing;
  - is dropped, with every other grant and unlock, by a PIN change, a new location, a recovery
    or a restart, and with this session's own grants when the session locks;
  - **is not an unlock**: `status` still says locked, and `media`, `media/file`, `upload`,
    `delete`, `move_out` and `encryption` still refuse the session. So a client that dies
    after the PIN leaves nothing open, and has nothing to lock again.
- **Clients:** Mission Control asks with its own PIN prompt. The Android app uses this
  Satellite's own unlock screen (`mobile/src/lockedFolder/VaultGrantPrompt.tsx`), with
  biometric unlock asking `biometric/unlock` for the same grant. Either way the moved items are
  then dropped from the shared screen, the app's offline copies and its image cache.
- **`move_in` with `items`** runs under this session's unlock (which it leaves as it was) or a
  matching grant. `photo_ids` keeps working for the dedicated screens, under an unlock.
- **Checked again at the moment of the move.** Under the move lock, each photo is resolved
  again just before its copy; the original's SHA-256 must match its content-addressed id; and
  the library removes it only if it is still active, under the lock every bin, restore, erase
  and purge takes. A photo binned, erased or moved since the request was checked is reported
  in `failed` and left where it is, with any vault copy undone.

### Keeping private media out of Photos

Photo asks two questions (`satellites/native/photo/private_media.py`), whether or not the
Locked Folder is currently enabled:

- **Is this path inside the vault?** Asked of the Engine (`files.protected`, see "Every
  Satellite asks the Engine"). Importing or scanning the vault itself is refused, and importing
  a folder that contains the vault (or links into it) skips the vault's files.
- **Was this file moved in from Photos?** Every move in records the file's SHA-256 (only the
  digest, never a name or path) in `sealed.json` next to `pin.json`. Photo answers such a file
  like a duplicate in a directory import, a phone sync upload and the standalone sync
  listener - so a phone that still has the photo stops re-sending it, and it never reappears
  in the gallery, search, albums, the map or thumbnails. Moving it back out clears the record.

## Encryption at rest

Encryption is **off until the owner turns it on** (Photos → Locked Folder → Settings →
"Encrypt Locked Folder"). Nothing is encrypted, rewritten or moved on upgrade or start-up. It
needs the engine's optional `encryption` extra (`uv sync --extra encryption`, which installs
[pyca/cryptography](https://cryptography.io/)); without it the vault stays unencrypted and
Settings says why.

### Threat model

| Who | What they have | Protected? |
| --- | --- | --- |
| Remote attacker, not signed in | Network access | Yes - every route needs a StarCore session (and sign-in is throttled). Encryption adds nothing here. |
| Signed in, without the PIN | A session (stolen cookie, shared computer) | Yes - every vault route checks this session's unlock on the server; PIN guesses are limited and the limit survives restarts. Encryption adds nothing here either: the server decrypts for whoever passes the check. |
| A copy of the vault folder, or the drive it's on | Disk or backup, without StarCore's data directory | **Yes, once encrypted** - only ciphertext, a keyring that opens with neither key, and file sizes and counts. Names and folders are encrypted too. |
| A stolen disk holding both the vault and StarCore's data directory | Everything at rest | **On Windows, yes** unless they also have the Windows account's password (the server key is DPAPI-protected). **On Linux/macOS, no** - the key file is on the same disk; use full-disk encryption. |
| Read access to the server's files as another account | Reading, not running code as StarCore | Windows: vault contents stay protected. Linux/macOS: the key file is mode 0600, so only root or StarCore's account can read it. Either way they can read `pin.json` and guess a short PIN offline - which gives them the PIN, not the files. |
| Write access to StarCore's files | Can replace or delete files | An edited, swapped or deleted `pin.json` or `devices.json` keeps an encrypted vault **locked** instead of letting a new PIN or key in (see "Security state bound to the vault"). Deleting files is still possible - that's data loss, not disclosure. Where they can read the server key too (Linux/macOS key file), they can forge anything. |
| Full server compromise | Code running as StarCore, or root/administrator | **No.** Server-side encryption can't help: the server holds the key so it can show photos after a PIN or fingerprint, and such an attacker can read it, or wait for an unlock. Only end-to-end encryption (keys never on the server) would, at the cost of server-side moves, thumbnails and streaming. |
| Lost PIN | - | Recoverable with the recovery key, if one was created. |
| Lost server key | Reinstall, new machine, Windows profile reset | Recoverable with the recovery key, if one was created. **Without one, the encrypted files are lost for good.** |

The PIN is an **access check, not a key**. That's deliberate: the brief this was built from
asked for PIN and biometric checks to stay separate from key management, a 4-12 digit PIN is
far too weak to protect a key from offline guessing, and biometric unlock (which never sees
the PIN) has to open the same vault.

### Design

Everything is AES-256-GCM and HKDF-SHA256 from `cryptography` - nothing invented here
(`crypto.py`):

- **The vault key** is 32 random bytes, generated once per vault. It is never derived from
  the PIN and never stored unwrapped.
- **Each file** gets its own key, `HKDF(vault key, random 32-byte salt, "…/file|" + vault id)`,
  and is encrypted in 1 MiB segments the way Google Tink's AES-GCM-HKDF streaming AEAD works:
  nonce = 7 random bytes ‖ segment number ‖ last-segment flag, and the file header as
  additional data. Videos are encrypted and decrypted one segment at a time (a 48 MiB file
  stays under 12 MiB of memory in the tests), and a Range request decrypts only the segments it
  needs, so seeking works.
- **Metadata** - the name, folder, date, size and SHA-256 - is encrypted at the end of the file
  (an upload's checksum is only known once it has all arrived), with the segment count as
  additional data, so a file cut short or extended fails before anything is read.
- **Integrity:** a changed, swapped, reordered, truncated or extended segment fails its tag
  before a byte of it is used. A file whose metadata fails is listed as **damaged** and never
  served; one whose contents fail is refused before the response starts (`500`), or - for a
  segment further in - the connection is closed, so only authenticated bytes are ever sent.
- **Nonces** never repeat: every file has its own key (random salt), and segment numbers never
  repeat within a file. The metadata nonce uses a counter value segments never reach.

Layout inside the vault folder:

```
.starcore-vault/keyring.json         the vault key, wrapped (below)
.starcore-vault/objects/<id>.sclf    one encrypted file each, random names
.starcore-vault/runs/<run>.json      the journal of each encryption run
.starcore-vault/backups/<run>/...    the originals that run encrypted, until deleted
.starcore-vault/tmp/                 decrypted copies on their way to Photos; emptied before each move out
```

### Key storage

`keyring.json` holds the vault key wrapped twice, each with AES-256-GCM:

- **The server slot** - wrapped by the **server key**, 32 random bytes in StarCore's data
  directory (`vault-key.dpapi` / `vault-key`, never in the vault). On Windows it's protected
  with DPAPI for the account StarCore runs as; elsewhere it's a file only that account can
  read (0600). This slot is how StarCore opens the vault after a PIN or fingerprint.
- **The recovery slot** (optional) - wrapped by `HKDF(recovery key, random salt)`.

The keyring is inside the vault, so a backup of the vault folder carries it. StarCore also
keeps a copy in its data directory (`keyrings/<vault id>.json`); if the one in the vault is
deleted or damaged, it's restored from there. With **both** copies gone, the vault key is gone
and so is every encrypted file - there is no other copy anywhere, by design. Keys never
appear in logs, API responses or configuration. While running, StarCore keeps the opened vault
key in memory (opening it means a DPAPI call), which a memory dump would reveal - that's part
of "full server compromise" above.

### Security state bound to the vault

Once the vault is encrypted, `pin.json` and `devices.json` each carry a `"binding"`: an
HMAC-SHA256, under a key derived from the vault key, of the PIN record (salt and hash) and of
the device list. Only something holding the vault key can produce it, so:

- **a swapped `pin.json`** (a PIN someone else knows) → `pin_tampered`, locked;
- **a deleted `pin.json`** → still "PIN set", `pin_tampered`, and no new PIN can be set
  without the recovery key;
- **a key added to `devices.json` by hand** → every device untrusted until re-enrolled.

Restoring *older genuine copies* of both files together (an old PIN someone knew) is not
detected. This protection depends on the server key being out of the attacker's reach - it
is on Windows, not with a readable key file.

### Recovery key

Created only if the owner ticks "Create a recovery key" when encrypting (on by default in the
dialog), or later from Settings with the PIN. It is 256 random bits shown **once** as 13
groups of four characters (`XXXX-XXXX-…`); the page makes the owner confirm they've stored it,
and it exists nowhere else - not in logs, files, responses after that one, or the page.

`POST /recover {recovery_key, pin}` - from the locked screen ("Forgot your PIN?") or the
"needs attention" screen:

1. opens the recovery slot - a wrong key is `401` and counts toward its own limit (5 tries,
   then lockouts doubling up to 24 hours, persisted);
2. if this server's key doesn't open the vault (a new server, a lost or unreadable key), wraps
   the vault key for this server again - an unreadable old key file is kept aside, not deleted;
3. sets the new PIN, bound to the vault; removes every biometric enrollment and every unlock,
   exactly like a PIN change; and clears the PIN lockout, since the key proves ownership.

It isn't a master password or a bypass: it is the owner's own secret for their own vault, it
doesn't weaken PIN checks, and an administrator can't produce one. **Anyone who has the
recovery key and can sign in to StarCore can reset the PIN** - keep it away from the server.
Settings can replace it (the old one stops working) or remove it, both with the PIN. Vaults
encrypted without one, and every unencrypted vault, have no recovery at all.

### Migration

Started explicitly, by an unlocked session, from Settings (`POST encryption/start
{recovery_key: true|false}`). It runs in the background with progress on the page:

1. **Check space.** Encrypted copies are made before any original moves, so it needs about the
   vault's size free, plus 64 MiB. Too little: nothing is changed (`507`).
2. **Set up keys.** `pin.json` and `devices.json` are bound first, then the keyring is written
   (to the data directory, then the vault) - a crash at any point leaves either the old
   unencrypted vault or a complete keyring the PIN matches.
3. **Encrypt each file** to a temporary `.part`, flush it to disk, decrypt it again and compare
   its SHA-256, then give it its final name, and record it in the run's journal (also flushed).
   A file that changes while it's read is skipped and retried later.
4. **Only when every file of the run passed**, move each original - by a rename, never a copy
   and delete - into `.starcore-vault/backups/<run>/`, then remove folders that became empty.
5. **Keep the backup** until the owner deletes it.

**Interrupted** (crash, power cut, full disk): every original is still in place until step 4,
and step 4 is a rename that is redone where it stopped. The page shows "Encryption didn't
finish", with **Resume** (checks every recorded copy again, then carries on) and **Undo**
(removes the encrypted copies; originals untouched). While a run is unfinished every file is
listed once - as its original until step 4, then as its encrypted copy.

Files added to the folder outside StarCore after encryption are listed as unencrypted, and
"Encrypt remaining files" runs again for them.

### Backups and restoring

- **Delete backup** (Settings, needs the PIN): every encrypted copy from that run that is
  still in the vault is decrypted and checked against its SHA-256 first; one that fails keeps
  the backup. Then the backup is deleted for good. Until then, the originals are still on disk
  unencrypted (protected by the PIN only, like before).
- **Restore originals**: puts a run's originals back where they were and removes their
  encrypted copies. Files deleted or moved to Photos since stay in the backup rather than
  coming back. Once nothing encrypted is left, the vault is simply unencrypted again (keyring
  removed).
- **Backing up an encrypted vault:** copy the whole vault folder, `.starcore-vault` included.
  Restored on the same server, it opens as before. Restored on another server, or after a
  reinstall, it shows "This server can't open the Locked Folder" and opens with the recovery
  key, which re-wraps it for the new server. Without a recovery key, back up StarCore's data
  directory too - on Windows that alone won't help on another machine or Windows account,
  because DPAPI ties the server key to the account.

### What happens if keys are lost

| Lost | Recovery key exists | No recovery key |
| --- | --- | --- |
| PIN | Reset it with the recovery key | Locked for good (the files can't be opened through StarCore) |
| Server key (reinstall, new machine, Windows password **reset** by an admin, damaged file) | Recover; the vault is re-wrapped for the new key | **Encrypted files lost for good** |
| `keyring.json` in the vault | Restored automatically from StarCore's copy | Same |
| Both keyring copies | **Encrypted files lost for good** - the recovery key opens the keyring, not the files | Same |
| Recovery key | Create a new one in Settings (needs the PIN) | - |

A normal Windows password *change* keeps DPAPI working; only a reset (by an administrator,
without the old password) loses it.

### Phones and the web

Nothing changes in how either client works: both list and fetch files through the same
routes, and the server decrypts as it sends. Web: video seeks with Range requests; responses
are `no-store`. Android: images are fetched into memory (`PrivateImage`), videos stream with
the session token, `FLAG_SECURE` stays on, and relocking is unchanged. The phone shows an
"encrypted" note and a "needs attention" state naming the problem; recovery and encryption
itself are done in Mission Control. Biometric unlock is unchanged - it never needed the PIN,
and a recovery reset removes enrollments like a PIN change.

### Verified, and not

Verified by the tests (all on temporary folders and synthetic files) and on an isolated demo
server in a browser: round trips at every segment boundary, Range reads, any changed byte,
truncation, extension and reordering rejected, wrong keys and other vaults rejected, constant
memory for a 48 MiB file, interruption mid-encryption and mid-backup, disk full before and
during, undo and backup deletion, damaged files never served, every private endpoint refusing
a locked or other session, uploads encrypted and File Explorer kept out, moves both ways,
recovery (wrong keys, limits across restarts, PIN lockout, lost server key, a restored backup
on a "new server"), bindings against swapped or deleted PIN files and planted devices, the
keyring restored from StarCore's copy, and DPAPI on Windows.

Not verified: a physical phone; Linux and macOS hosts (the 0600 key-file path is tested only
as far as Windows allows); a real power cut or real full disk (both are simulated); a real
Windows password reset (DPAPI's documented behaviour).

### Limitations

- **Not protection against a compromised server**, or anyone who can read the server key.
- **Linux/macOS:** the server key is a plain file - full-disk encryption is what protects a
  stolen disk there.
- **Leaks:** file sizes, counts and change times stay visible in the vault folder.
- **PIN guessing offline:** `pin.json` is still PBKDF2 of a short PIN; someone who can read it
  can find the PIN offline. That gives them the PIN, not the files.
- **The backup is plaintext** until deleted - delete it once the files are checked.
- **Rollback:** restoring older, genuine copies of security files together isn't detected.
- **Decrypted copies:** moving a file to Photos, or rendering an encrypted video's poster frame,
  puts a decrypted copy in `.starcore-vault/tmp/` for the moment it takes (never a shared temp
  folder). It is removed in a `finally`; a killed process leaves it there until the next video
  thumbnail or move to Photos sweeps copies older than 10 minutes. Streaming the plaintext to
  FFmpeg instead isn't reliable (an MP4 whose index is at the end can't be read from a pipe), so
  this temporary plaintext file on disk is a known limitation.
- **Video thumbnails** (needs FFmpeg on PATH) are rendered to a pipe and held only in server
  memory (`media/thumbnail`, `media/duration`), never stored, and dropped when the last session
  locks. A failed frame is retried when FFmpeg is installed (no restart) or after 5 minutes.
- **No key rotation:** changing the vault key would mean re-encrypting everything.

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
with five states - set up a location, create a PIN, locked (PIN entry with a countdown during
a lockout, and "Forgot your PIN?" when a recovery key exists), needs attention (a security
problem, with the recovery form when it can help), and unlocked (a grid of photos and videos,
other files listed below, a viewer with "Move to Photos" and "Delete", upload, and settings
for changing the PIN, encryption, the recovery key, backups and delinking). A
photo's viewer in Photos has a lock button that moves it in, asking for the PIN first when
needed and locking again straight after, whether the move worked or not. If that lock can't be
sent (the connection dropped), the notice says so and when the server's time limit locks the
vault by itself - never a plain "Moved" - and the lock is tried again when the browser is back
online or with a `sendBeacon` as the page goes away
(`satellites/native/photo/mission_control/lockedMove.js`). The tab locks again when you switch tabs, leave
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
storage = "data"                # where pin.json, attempts.json, devices.json, sealed.json,
                                # the server key and the keyring copies are kept - see below
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

## Every Satellite asks the Engine: `files.protected`

No Satellite that takes a path on disk names the Locked Folder. Each asks the Engine,
`starcore.capabilities.protection(engine, path, token, tree=False)`, which asks every Satellite
providing `files.protected` v1 through its `check` operation and combines their answers:

```
GET check?path=<absolute path>[&tree=1]  ->  {protected, open, message?}
```

- `protected`: the path is the vault or inside it; with `tree=1`, also a folder that contains
  it (for what acts on a whole tree: renaming, deleting, scanning).
- `open`: this session may reach it through other Satellites now - it has unlocked the vault,
  and the vault is neither encrypted nor being encrypted (then only the Locked Folder's own
  routes reach it, unlocked or not). A folder that contains the vault is open once unlocked.
- `message`: the words for a refusal, which File Explorer returns with its `403`.

The Engine asks **every provider, enabled or not**: disabling a Satellite needs only a session,
never the PIN, so it must not open the vault. Its routes stay served while it is disabled, so
the owner can still unlock it, and `check` creates the runtime if nothing has yet, so the first
request after a restart is guarded like every other. A provider that fails, or answers anything
but the protocol, keeps every path closed (with a warning in the log) - File Explorer then
refuses everything until it is fixed. With no provider at all, nothing is protected.

Who asks:

- **File Explorer** (`file_explorer/protection.py`): every route that touches a path, after
  resolving it (`..`, symlinks); `tree=1` for `rename` and `delete`. A listing asks once about
  its folder as a tree, then about each entry only if the folder holds a protected area, to
  set the `locked` flag. Its `files stat` command refuses any protected path: the command line
  has no session.
- **Photo** (`photo/private_media.py`): an import or scan of a protected path is refused, and
  each file of a folder import is checked on its resolved path, so a link into the vault is
  skipped. Photo takes nothing in from the vault even for a session that has it open.
- **Music** (`music/library.py`, `music/scanner.py`): a scan whose source, or one of whose
  configured folders, is in a protected area is refused; a scan of a folder that contains the
  vault skips it. Also for an unlocked session: what is indexed outlives the unlock.

A session that hasn't unlocked the vault can learn from `check` whether a path it names is
protected, as it could already from File Explorer's lock flag and `403`; it never learns the
vault's path from `status` or the settings (A5).

After a **reload** of the Satellite, `check`, the routes and Photo still share one runtime: it
lives in the cached `runtime.py` module, keeps every unlock, grant and counter, and from then
on reads the rebuilt Satellite's configuration. A location that changed in `config.toml` before
the reload ends every unlock, as a change through the settings does.

Whether a photo was moved in from Photos (`sealed.json`) is still asked of the Locked Folder's
live runtime (`satellite.locked_folder_runtime`, warmed up through its state provider) by
Photo's `private_media.py`, until L6 moves it to `media.vault`.

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

`engine/tests/test_locked_folder_encryption.py` covers encryption at rest, persistent
lockouts and recovery, again only on temporary folders and synthetic files:

- **the file format:** round trips at every segment boundary; Range reads; nothing readable
  left in a file; any changed byte, cut-short, extended or reordered file rejected; the wrong
  key or vault rejected; a 48 MiB file in constant memory; key wrapping; recovery-key parsing;
- **the server key:** created once; DPAPI-protected on Windows; the owner-only file; a damaged
  key reported, not replaced;
- **persistent lockouts:** session and account-wide lockouts surviving a restart; parallel
  guesses all counted on disk; no token stored; damaged counters locking out for one period
  then healing; a far-future deadline capped; an unsaveable attempt refused; typos forgotten
  after a day;
- **migration:** every file kept and nothing readable left; seeking in video; the recovery key
  never stored or logged; nothing happening without an explicit start; interruption
  mid-encryption and mid-backup, and resuming; too little space and a disk filling up; undo
  and backup deletion (needing the PIN and good copies); damaged files never served, including
  a segment damaged mid-file; uploads encrypted and File Explorer kept out; moves both ways;
  a failed move out; every private endpoint refusing a locked or other session; no encryption
  package;
- **bindings:** a swapped or deleted `pin.json` and a planted device keeping the vault locked;
  the keyring restored from StarCore's copy; both copies gone;
- **recovery:** a PIN reset that removes devices; limits that survive a restart; working during
  a PIN lockout; a lost server key; a backup opened on a "new server"; no recovery key, no way
  back; replacing and removing the recovery key.

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

`engine/tests/test_locked_folder_security.py` also covers moves from a shared interface:
- a grant moving exactly its items once, without unlocking the vault;
- a grant used up by a mismatched, refused or replayed request;
- a grant bound to its session, expiring, dropped by a PIN or location change, and needing the
  right PIN with attempts counted;
- six concurrent requests with one grant moving at most once;
- forged references (another provider or capability, an unknown, binned or malformed id, an
  extra key) refused before any attempt is counted, and a mixed request moving nothing;
- a photo binned just before its copy left in the bin;
- the library refusing to remove a binned photo for a move;
- Photo resolving only active library items, and no reference resolving without an enabled
  provider;
- a biometric unlock asking for a grant.

It covers `files.protected` too (A2, L1): the Engine's answer inside and outside the vault, for
a folder that contains it, unlocked and for another session; an encrypted vault never open to
other Satellites; a disabled provider still protecting; no provider protecting nothing; a
provider that fails or answers nonsense keeping every path closed; `check` needing an absolute
path; and Music refusing to scan the vault (even unlocked, also in the background, also with
the provider disabled) while a scan of its parent folder, or of the configured library, skips it.

`satellites/native/photo/tests/lockedMove.test.mjs` (`node --test`) covers moving a photo in
from Photo's own web page: locking again after a successful and after a failed move, an
already unlocked session moving without a prompt, cancelling or a missing PIN moving nothing,
and a lock that can't be sent being reported with when the vault locks by itself, then tried
again once when back online or as the page goes away.

## Security audit and plan: the Locked Folder in the shared interface (2026-11-15)

**Status: approved by the owner (2026-11-15). L0 is done: A1, A5 and A9 are fixed. Nothing
else below is implemented yet**, and the decisions at the end stay open until the milestone that
needs them. Read from the code at `5b716a9`. It is the audit stage 4 of [Remaining work](../remaining-work.md)
asks for, as M5 had ([its audit](../archive/m5-locked-folder-actions-audit.md)). The common
order with Photos and the phone sync is in Remaining work.

### What protects the vault today

- **The server decides, per session.** Every route that reads or changes the vault (`media`,
  `media/file`, `upload`, `delete`, `move_in`, `move_out`, `encryption`) asks
  `is_unlocked(token)`. An unlock belongs to one session token, lasts a fixed
  `session_timeout_seconds` (900), lives in memory only, and is dropped by a PIN change, a new
  location, a recovery or a restart.
- **The PIN** is PBKDF2-HMAC-SHA256 (260,000 rounds, per-PIN salt). An attempt is counted and
  saved to disk before the PIN is looked at; five wrong ones lock the session, twenty lock the
  account, doubling up to 24 hours. Damaged security state keeps the vault locked.
- **Biometrics** are a server-verified RSA signature over a single-use challenge of this
  session. A client that only claims a match gets nothing.
- **`media.vault`** offers `status`, `unlock`, `lock`, `move_in` and `biometric`: nothing that
  lists or reads.
- **The `secure` action** is accepted by the Engine only in a media viewer's or selection's
  actions, only for `media.vault` / `move_in`, only in a document whose Satellite provides
  `media.gallery`, and with no route, body or form. The client builds the references from the
  catalog and asks for the PIN in its own prompt (`mission_control/ui/secure.js`; on Android a
  native prompt that hands shared code only the grant). The PIN buys a grant: one session, one
  operation, exactly those items, 60 seconds, used up by the first request. A grant opens
  nothing else.
- **File Explorer's guard** refuses, for a path inside the vault and a session that hasn't
  unlocked it: `entries`, `view/folder`, `view/file`, `content`, `upload`, `mkdir`, `rename` and
  `delete`; renaming or deleting a folder that contains the vault; and everything inside an
  encrypted or encrypting vault, even unlocked. Paths are resolved first (`..`, symlinks).
- **Photo** refuses to import the vault and answers a file that was moved in as a duplicate.
- **At rest:** see "Encryption at rest". Off until the owner turns it on.
- **In transit:** the session cookie (`HttpOnly`, `SameSite=Lax`) or bearer token; the PIN in
  the JSON body of `unlock`, `pin`, `biometric/enroll`, `recover` and the two encryption
  confirmations; the recovery key once, in the answer of `encryption/start` or
  `encryption/recovery_key`. Vault files are sent `no-store`. The Android app sends the token
  as a header, never in a URL, and holds vault images in memory.

### Findings

| # | Finding | Severity | Fix |
|---|---|---|---|
| A1 | **Disabling the Locked Folder Satellite removes File Explorer's guard.** `locked_folder_guard._runtime()` answers "nothing to guard" for a disabled Satellite, and `POST /api/satellites/LockedFolder/disable` needs only a session. Checked with a throwaway test on temporary folders: for a session that never gave the PIN, listing the vault and reading a file in it went from `403` to `200`. For an encrypted vault the same step shows only ciphertext, but also the unencrypted originals in `.starcore-vault/backups/` until that backup is deleted, and lets all of it be renamed or deleted. Photo's `private_media.py` already ignores `enabled`; the guard doesn't. | **High** | Fixed in L0: the guard protects whether the Satellite is enabled or not. Then L1: protection is asked of the Engine, which asks every provider, enabled or not. |
| A2 | **Protection is opt-in per Satellite.** File Explorer and Photo ask; any other Satellite that takes a server path doesn't. Music's `scan` accepts any `source` and never asks, so a signed-in session can index and stream the audio files of an unencrypted vault (read in the code, not exercised). | Medium | Fixed in L1: one Engine check (`files.protected`) that File Explorer, Photo and Music ask, Music included: a scan source in the vault is refused, a parent folder's scan skips it. |
| A3 | **A full unlock opens everything for 900 seconds and outlives a dead client.** Accepted in M5 (its F3) because the shared interface never unlocked. Browsing the vault from the shared interface makes the full unlock the ordinary path on both clients, and locking on leaving is best effort: a crash, a lost connection or a killed app leaves the session open, also to File Explorer for an unencrypted vault. | Medium | L2: an unlock also ends after a short idle time, kept alive only by a client that is showing the vault. |
| A4 | **What a session is worth bounds what the PIN is worth.** Session tokens are stored unhashed in `auth.json`, last 7 days, and the cookie is `Secure` only when the Engine itself serves HTTPS (not behind a TLS proxy). The app allows cleartext to any host. On plain HTTP the token, the PIN and the recovery key are readable on the network, so the PIN adds nothing against someone who can listen. | Medium, Engine-wide | Not the Locked Folder's to fix: the hashed tokens of Stabilisation, plus `Secure` on the cookie behind an HTTPS proxy. Until then this page says the vault's guarantees assume HTTPS. |
| A5 | **`status` tells any signed-in session the vault's absolute path**, with the lockout counters and encryption state, before any unlock. The path is what A1 and A2 need. | Low | Fixed in L0: the path, in `status` and in the settings, only for an unlocked session, or while no PIN is set (setup). |
| A6 | **A biometric signature isn't bound to what it is for.** `for` travels beside the signed challenge, not in it, so one signature is good for a grant or for a full unlock, whichever the request says. | Low | L2: the purpose is given when the challenge is asked for and kept with it on the server. |
| A7 | **Secrets in the shared interface could become document inputs** (M5's F4, now concrete: setting a PIN and recovery move to the shared interface). A form field that takes a PIN teaches people to type it into whatever a document draws. | Low, design rule | L4: secrets are typed and shown only in prompts the client owns, and only for a protected document. |
| A8 | **Unlocks and grants stay in memory after a sign-out** or a revoked session. Nothing can use them: authentication refuses the token first. | Low, accepted | Lapses by itself with A3's idle time. |
| A9 | **Robustness:** `is_unlocked()` and `unlock()` change the unlock table outside the runtime's lock (a concurrent expiry can raise and answer `500`, never open anything); `unlock()` clears a counter by the raw token while the table is keyed by its hash (a no-op, `record_success()` does the real reset). After a Satellite **reload**, whether the guard and the routes still share one runtime has not been checked. | Low | Fixed in L0. Checking the reload found a real gap: the cached runtime kept reading the old Satellite's configuration, so a location set after a reload was not the one File Explorer guarded. It now follows the rebuilt Satellite. |

**Who can do what.** A Satellite's Python has full rights on the server: installing one is the
trust decision, and no contract protects the vault from it. A **document** can do nothing to
the vault: its routes stay inside its own Satellite, and it never sees a PIN or a grant. A
**client holding a session but not the PIN** could use A1, A2 and A5, and guess within the
attempt limits; since L0 it has A2 and the guessing, and after L1 only the guessing is left. A client holding both is the owner.

### Design

Five rules, each testable:

1. **The Locked Folder gets its own `ui.json`**, drawn by the shared renderers, over its own
   routes. Nothing about the vault is added to Photo's document.
2. **A document can declare itself protected** (contract, L2):
   `"protected": {"capability": "media.vault", "setup": "<page>"}`. The Engine accepts it only
   when the document's own Satellite provides that capability. For such a document the client:
   - asks `status` before any page. Not configured, no PIN, or a security problem: it opens
     the `setup` page, whose routes the server already serves without an unlock (a first PIN, a
     location while nothing is protected, recovery). Locked: its own prompt (PIN; biometrics
     on Android), asking `unlock` for this session;
   - treats a `403` from any of the document's routes as "locked again": the prompt, not an
     error;
   - locks when the document closes, when the tab is hidden or the page goes away, when the app
     goes to the background and when the server changes;
   - keeps the unlock alive only while it shows the document (`keep`, below);
   - keeps nothing: no offline page, no widget, no share, images and videos never in a disk
     cache (on Android fetched into memory, as `PrivateImage` does today), and on Android the
     window can't be captured (the reserved `secure.screen`, claimed then).
3. **The idle time is the server's** (L2): an unlock ends at `session_timeout_seconds` or after
   90 seconds without a request to a vault route or to `keep` (a new optional operation of
   `media.vault` v1: `POST keep` -> `{expires_at}`, only for a session that is unlocked).
   `status` never extends anything. A client that dies leaves at most 90 seconds.
4. **Secrets belong to client prompts** (contract, L4): an action of a protected document may
   declare `secrets` (`{"pin": {"kind": "pin", "new": true}}`: the client asks in its own
   prompt, twice for a new one, and puts the value in the request body under that key, never
   in `$form` or `$state`) and `reveal` (`"reveal": "recovery_key"`: the client shows that field
   of the answer once, in its own dialog, with a confirmation that it was stored, and keeps it
   nowhere). Kinds are a closed list (`pin`, `recovery-key`); the prompt's words are the
   client's and name the Satellite that asks. The Engine refuses both outside a protected
   document, so no other document can raise a PIN prompt.
5. **Satellites reach each other through the Engine** (L1, L6): `files.protected` v1 (`check`:
   `GET ?path=` -> `{protected, open}` for this session), asked through an Engine helper that
   consults every provider, enabled or not; later `media.vault`'s optional `sealed` and
   `media.gallery`'s optional `original`, `release` and `adopt`, so the vault and the library
   move files without importing each other.

Sections: a client opens another Satellite's document from inside its host with the **`section`**
action (contract, L2): `{"section": "$.section"}` opens the document of a Satellite whose
manifest says `section_of` this one, and nothing else. Photo's albums route lists its sections
from the Engine's registry (title and `icon_name` from each manifest), so the Locked Folder's
tile stays where it is and Photo names nothing.

### Milestones

| # | What | Contract | Main files | Tests | Model |
|---|---|---|---|---|---|
| L0 (done) | Close A1; `status` and the settings without the path while locked (A5); the unlock table under the lock, the reload case (A9) | none | `file_explorer/locked_folder_guard.py`, `locked_folder/api.py`, `configuration.py`, `runtime.py` | `test_locked_folder_security.py`: a disabled Satellite still guards, also from a cold start; a locked `status` and configuration have no path; after a reload the guard and routes agree, and a new location is the one guarded; concurrent expiry never raises | Opus 5.5 high |
| L1 (done) | `files.protected` v1 and the Engine's check; File Explorer, Photo and Music ask it (A2) | vocabulary: one Satellite capability | `contracts/ui/vocabulary.json`, `engine/starcore/capabilities.py`, the guard (becomes `protection.py`), `photo/private_media.py`, `music/routes_catalog.py`, `locked_folder/satellite.toml` | Engine: provider disabled, no provider, Music's scan refused inside the vault; the three contract suites still agree on the vocabulary | Opus 5.5 high |
| L2 | Protected documents, the `section` action, `keep` and the idle time, purpose-bound challenges (A3, A6); the generic unlock prompt on Android (`mobile/src/vault/`) and the web's prompt for a full unlock | **contract change 1** | `engine/starcore/ui_contract.py`, fixtures, `mission_control/ui/` (contract, renderer, `secure.js`), `mobile/src/satellites/ui/`, `mobile/src/vault/` (from `src/lockedFolder/`), `builtins.tsx`, `locked_folder/runtime.py` and `api.py` | fixtures valid and invalid (protected without the capability, with `offline`, `secrets` outside it); Engine idle expiry with a fake clock; both clients: gate, `403`, lock on leave, nothing cached | Opus 5.5 xhigh |
| L3 | The Locked Folder's `ui.json`: grid, viewer, move to Photos, delete, upload, download; Photo's tile through sections | data only | `locked_folder/ui.json`, `views.py` (new), `photo/gallery.py`, `photo/ui.json` | Engine: the document validates, every route it names exists and refuses a locked session; app: the document renders | Opus 5.5 high |
| L4 | `secrets` and `reveal`, and repeatable form rows (`rows` field kind) in the same change; then the vault's settings and setup pages | **contract change 2** | as L2's contract files, the form renderers on both clients, `locked_folder/ui.json` | fixtures; both clients: a secret never in form state, storage or logs, a revealed value gone after closing; Engine: every management route still needs what it needs today | Opus 5.5 xhigh |
| L5 | End to end on the local demo (web and emulator) with a generated PIN; the owner validates on the web and the phone | none | none | the M5 list, plus: kill the client while unlocked and see it lock by itself | Opus 5.5 high |
| L6 | Moves through capabilities (`sealed`, `original`, `release`, `adopt`); comments that name the other Satellite go | vocabulary: optional operations | `locked_folder/vault.py`, `photo/private_media.py`, `photo/api.py`, `capabilities.py` (POST calls) | the existing move tests unchanged; `KNOWN_CROSS_SATELLITE` loses three lines | Opus 5.5 xhigh |
| L7 | Security review of L0 to L6 | none | none | findings fixed before L8 | Fable 5.2 high |
| L8 | Remove `locked_folder/mission_control/page.js`, `mobile/src/lockedFolder/`, Photo's `LockedFolderTab` | none | those | the suites | Sonnet 5.5 medium |

Until L8 the Locked Folder's own page and screens keep working; in L2 they get the same `keep`
call, so the idle time doesn't lock them while they are open.

### Decisions for the owner

1. **Idle time (rule 3):** 90 seconds kept alive by the client (recommended), or the fixed 900
   seconds as today with locking on leave only.
2. **Secrets (rule 4):** client prompts on the protected document's own routes (recommended:
   generic, and nothing but the vault's own Satellite can ask), or every management step as an
   operation of `media.vault` (no secret ever reaches a document route, but the capability
   then carries encryption, recovery and backups, which are this Satellite's own features).
3. **A1 now:** L0 is small and independent. It can go first, before anything else in this plan.
