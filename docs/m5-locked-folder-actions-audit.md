# M5 security audit: Locked Folder actions from the shared interface (2026-11-08)

The audit comes before implementation. M5 is milestone 5 of the Photos roadmap in
[`photos-parity-audit.md`](photos-parity-audit.md) (gap #24): "Move to Locked Folder" from the
shared Photos viewer and selection, on the web and on Android, without weakening the Locked
Folder. I read the code at `42ff5e4`. Nothing has been implemented.

## 1. What exists today (confirmed in the code)

**The server enforces everything** (`satellites/native/locked_folder/api.py`):
- `_require_unlocked` checks *this session's* unlock (`live.is_unlocked(request.token)`) on
  every route that reads or changes the vault: `media`, `upload`, `delete`, `move_in`,
  `move_out` and `encryption`. A locked session gets `403`.
- `_require_idle` refuses vault changes with `409` while the vault is being encrypted.
- **Unlocking:** `POST unlock {pin}`, or `POST biometric/challenge`, then
  `POST biometric/unlock {key_id, challenge, signature}`.
  - Attempts are counted before they are checked (`_begin`), with a lockout after
    `max_pin_attempts`.
  - A biometric challenge belongs to one session, works once and expires after 2 minutes.
    The server checks the signature against the enrolled RSA-2048 key; a client that merely
    claims a match gets nothing.
  - Damaged or edited security state keeps the vault locked (`security_problem()`).
- **Unlock lifetime:** an unlock belongs to one session token and lasts
  `session_timeout_seconds` (900 by default). It is held in memory only, so a restart locks
  everything. `POST lock` ends it.
- **`move_in {photo_ids}`** copies the original into the vault and checks its SHA-256 before
  removing the photo from the library, its albums and its thumbnails. If anything fails, the
  photo stays where it was. The digest is recorded in `sealed.json`, so phone sync never
  sends the photo back.
- The Locked Folder **provides no Satellite capability** (`docs/ui-contract.md`, "Shared blocks
  and Satellite capabilities"), and Photo's `media.gallery` never includes vault items.

**The dedicated clients' flow** is the same on both:
1. Read the status.
2. Not configured, or no PIN: send the person to the setup.
3. Locked: show the Locked Folder's own unlock prompt (PIN; biometrics on Android).
4. `move_in`.
5. Lock again: "the unlock was only for the move".
6. Drop the photo from the client's lists and caches.

Where each step lives:
- Web: `satellites/native/photo/mission_control/page.js`, `moveViewedPhotoToLockedFolder`,
  with the prompt from the Locked Folder page's `requestUnlock`.
- Android: `mobile/src/photo/PhotoViewerScreen.tsx`, with `LockedFolderUnlock.tsx` and
  `biometricUnlock.ts` in `mobile/src/lockedFolder/`. It also evicts the thumbnail and the
  original from the image cache, and forgets the cached photo list and offline copies.

**The contract today** (`docs/ui-contract.md`, "Actions"):
- A document's `route` stays inside its own Satellite's `/api/satellites/<name>/`.
- A document can't reach another Satellite, so Photo's `ui.json` can't call
  `LockedFolder/move_in`.
- `own` opens the native Locked Folder, but it can't act on a photo.

## 2. Findings

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| F1 | **The dedicated web page doesn't lock again after a failed move.** `/lock` runs only after a successful `move_in`. If the move fails after the PIN was entered (409 during encryption, a full disk, a hash mismatch), the session stays unlocked for up to 900 s, and anything sharing that session can list and download the vault. Android locks again in `finally`. | Medium | Exists today. Fix: lock again in `finally`, as Android does. |
| F2 | **A Photo document can't express the move at all**, because routes are confined to the document's own Satellite. This is a safeguard to keep, not a bug: M5 must not add "call another Satellite's route" to the contract. | – | Design constraint |
| F3 | **Every unlock is a whole-vault unlock.** An unlock granted for a move also opens `media` and `media/file` for that session until it locks again or times out. The lock-again step is therefore part of the security model, not a courtesy. | Low (accepted today) | Keep, and enforce in the shared clients (R5) |
| F4 | **A PIN prompt drawn by a document could be a phishing surface.** A contract `form` sends its values to the document's own route, so a Satellite document could ask for "your Locked Folder PIN" and receive it. Installing a Satellite is already the trust decision (its Python runs with full rights), but the shared interface must never *teach* people to type the PIN into a document's form. | Low | Design rule R2 |
| F5 | **Offline copies after a move.** M4's `SatelliteUiScreen` forgets the acting Satellite's offline copies *for this session* after a successful action. The dedicated screens forget them for **every** session (`forgetOfflineSatellite`). A moved photo's metadata (title, date, camera) could otherwise stay in another session's offline copy for up to 7 days. Thumbnails and originals in the image cache are evicted only by the dedicated Android viewer. | Medium | M5 must do both (R7) |
| F6 | **`move_in` takes bare Photo ids** and is hard-wired to Photo (`vault.move_in(request.engine, …)`). This is fine while only Photo calls it. A capability reached from any document would let another Satellite's document hand it ids it didn't serve. | Low | Design rule R3 |
| F7 | **The unlock prompt's code is named after the Locked Folder.** `mobile/src/lockedFolder/*` and the Locked Folder's `page.js` can't be imported by the shared renderers (`test_client_modularity.py`). Reuse has to go through a generic seam. | – | Design constraint |
| F8 | **Released Alpha clients** don't know the new action. The Photo document is a preview (`document.preview`), so a client without the action keeps the dedicated screens, which already have the move. A client that knows 1.2 but not the new action must hide the button, as for `own`. | – | Compatibility rule R9 |
| F9 | **No server-side brute-force gap.** A shared prompt that uses the same `unlock` and `biometric/*` routes inherits the attempt counting, lockout and `Retry-After` unchanged. | – | Confirmed safe if R1 holds |

## 3. Recommended design (to approve before implementation)

**Reuse the existing Locked Folder authentication as it is.** No new unlock route, no PIN on any
other route, no client-side trust.

1. **A Satellite capability from the Locked Folder**, for example `media.vault` v1, declared in
   `satellites/native/locked_folder/satellite.toml`. Its operations map to the existing routes:
   - `status` → `GET status`;
   - `unlock` → `POST unlock`;
   - `biometric` → `POST biometric/…`, optional;
   - `lock` → `POST lock`;
   - `move_in` → `POST move_in`.

   It has **no** `media` or `move_out`, so the shared interface can never list or read the
   vault. Viewing it stays native, through `own: "locked"`.
2. **A new action in the 1.2 vocabulary** (1.2 is still unreleased): for example
   `{"secure": {"capability": "media.vault", "operation": "move_in"}, "items": "<binding>", "confirm": "...", "then": "refresh"}`.
   - It reaches no route of the document's own, the same model as `pick` and `play`.
   - The Engine, the web and Android validate it against the vocabulary, with fixtures,
     valid and invalid.
   - It works from the viewer (one item) and from a selection (many).
3. **Client-owned "unlock first"**: the client, never the document, runs the dedicated flow
   from section 1 against the provider the catalog names:
   1. `status`: if the Locked Folder isn't configured or has no PIN, show a notice offering
      `own: "locked"`.
   2. The client's own unlock prompt: PIN, plus biometrics on Android.
   3. `move_in`.
   4. **`lock` in `finally`.**
   5. Evict the item's images, forget offline copies for every session, then refresh.
4. **Where the prompt lives:**
   - Android: move the logic of `LockedFolderUnlock` and `biometricUnlock` behind a generic
     "vault unlock" component driven by the capability's operations. Only
     `mobile/src/satellites/builtins.tsx` may wire anything named.
   - Web: a small generic PIN dialog in `mission_control/ui/`, speaking the same operations.
     The shared renderer must not load the Locked Folder's `page.js`.
5. **References instead of bare ids** (optional, recommended): `move_in` also accepts
   `items: [{provider, capability: "media.gallery", id}]`, as the `pick` action's references
   do. It refuses a provider other than the `media.gallery` provider it moves from, and
   `photo_ids` keeps working for the dedicated clients.

## 4. Requirements M5 must meet (testable)

- **R1.** Unlocking uses only the existing `unlock` and `biometric/*` routes. Attempt limits,
  lockout and `Retry-After` are shown as they are today.
- **R2.** The PIN is entered only in a prompt the client owns:
  - never a contract `form`, never `$state`, never a document route;
  - never logged, stored or kept after the request;
  - the document supplies no prompt text.
- **R3.** The action reaches only the capability's `move_in`, with items of the document's own
  `media.gallery`. The Engine refuses any other operation, and the Locked Folder refuses
  references from elsewhere.
- **R4.** The server is the only authority. Every capability call carries the session token,
  and a locked session gets `403`. Tests cover a client that skips the prompt.
- **R5.** Lock again after **every** outcome: success, failure, cancel and leaving the screen.
  Fix F1 in the dedicated web page at the same time.
- **R6.** Nothing from the vault is ever shown, cached or listed by the shared interface. The
  capability has no read operation.
- **R7.** After a move, on both clients:
  - offline copies are forgotten for every session (`forgetOfflineSatellite`);
  - the item's thumbnail and original are evicted from the image cache;
  - the item leaves the viewer and the grid;
  - partial failures (`failed`) are reported per item.
- **R8.** No provider, disabled, not configured or no PIN: the button is hidden or the client
  shows a notice. A 409 during encryption is shown as the server's message.
- **R9.** Compatibility: the change is additive to 1.2, so 1.0 and 1.1 documents and released
  Alpha clients are unaffected. The dedicated screens keep their own flow.

## 5. Tests and review for M5

- **Engine:**
  - capability declaration and protocol checks;
  - action validation, with fixtures (an unknown operation, a missing capability, an action
    without items);
  - `move_in` with references, including a reference from elsewhere refused;
  - a locked session refused.
- **Clients:**
  - the prompt shown only when locked;
  - lock called on success, failure and cancel;
  - the PIN absent from storage and state;
  - offline copies and images forgotten;
  - the button hidden without a provider.
- **End to end:** on the local demo only, with a **generated** test PIN (never the device PIN),
  on the web and the emulator:
  - move one photo, then move a selection;
  - check that the session is locked afterwards;
  - check that the photo is gone from Library, Search, Map and the offline copies;
  - check that it is in the vault, through the native Locked Folder.
- **A security review** of the diff before any commit.

## 6. Open decisions for the owner

1. **Action shape and name:** `secure` with `operation` (recommended), or a narrower `vault`
   action fixed to `move_in`.
2. **References in `move_in`** (section 3, item 5), or only `photo_ids` for now.
3. **Whether to fix F1 in the dedicated web page as part of M5** (recommended), or as its own
   small fix.

## 7. Revision (2026-11-08): approved decisions and three added requirements

**Approved:**
- Decision 1 A: a generic `secure` action, allowing only `media.vault` / `move_in` at first.
- Decision 2 B: explicit references.
- Decision 3 A: F1 fixed within M5, as its own commit.

All three stand. The review below changes how they are carried out, not which options were
chosen.

### 7.1 References validated on the server

What a client sends is a claim, never proof. The `provider` and `capability` in a reference
only say what the client thinks the item is.

- **The Engine owns the answer.** A new Engine helper, for example
  `catalog.resolve("media.gallery", reference)`, finds the enabled provider in the registry,
  never from the reference.
  - The reference's `provider` must equal that provider's registered name, and its
    `capability` must be `media.gallery`. Anything else is refused.
  - The provider confirms the id through a new operation, `resolve` (an id to `{id, kind}` or
    "unknown"). *As built:* capability versions are whole numbers, so `resolve` is an
    optional operation of `media.gallery` version 1 (additive), and the Engine refuses to
    resolve references for a provider that doesn't offer it.
  - Only active library items resolve: never the bin, and never an item already in the vault.
- **The Locked Folder** resolves every reference before it moves anything.
  - If any reference fails, it refuses the whole request (`400`, listing the bad
    references), so a forged reference can't take part in a partial success.
  - It moves by the **resolved** id, never by the client's string.
- **The document's own Satellite** must be the `media.gallery` provider. The Engine refuses a
  `secure` action in any other Satellite's document at load time, and the client builds the
  references from the catalog, never from document data.
- **Limits:** at most 500 references per request, the same as the bulk limit.
- **Tests:**
  - a forged provider, a forged capability, an unknown id, a binned id and an id already in
    the vault are each refused;
  - a valid and an invalid reference mixed in one request: nothing is moved;
  - a disabled Photo means no provider, so the request is refused;
  - the existing `photo_ids` path is unchanged.

### 7.2 Locking that holds when a client crashes or loses its connection

Confirmed in `runtime.py`: an unlock lasts a fixed `session_timeout_seconds` (900 by default),
in memory only. A restart, a PIN change or a vault location change ends every unlock. A
client's `lock` in `finally` is only best effort.

**Server guarantee: an unlock for a single action.** `unlock` and `biometric/unlock` accept
an optional `{"for": "move_in"}`. That grant is not the session's normal unlock:
- It lasts **60 seconds**.
- It is **used up by the first `move_in`**, whatever its outcome.
- It **never opens** `media`, `media/file`, `delete`, `move_out`, `upload` or `encryption`.

It goes through the same routes and the same PIN or signature check, so the same attempt
counting and lockout apply.

So even if the client dies right after the PIN, the vault is never openable after a shared
move. The worst case is that the grant lapses unused within 60 s, and until then it can only
run `move_in`. If the session was already fully unlocked (the native Locked Folder open), the
action runs under that unlock and leaves it as it was.

**Other cases:**
- **Sign-out or a revoked session:** authentication refuses the token before any Locked Folder
  route runs. The unlock record lingers in memory until it expires, but nothing can use it.
  Dropping it on sign-out would need a small Engine hook; it is optional.

**Client handling of a failed lock:**
- With a single-action grant there is nothing for the client to lock.
- When the client does call `lock` (the dedicated flows, or a full unlock):
  - **Move done, lock failed:** the client says "Moved to the Locked Folder. It couldn't be
    locked again: it will lock by itself at <time>". The time comes from `expires_at`. The
    notice is never a plain success.
  - **The lock is retried** once when the connection comes back, and when the screen closes.
  - **Android:** if the app goes to the background with a lock still pending, it records
    the pending lock (with no secret in it) and sends `lock` on its next start for that server.

F1's fix in the dedicated web page follows the same rules: lock in `finally`, and if that fails,
show a notice with the time it locks by itself.

**Tests:**
- the grant is used up by one `move_in`, including a failed one;
- the grant refuses `media` and `media/file`;
- the grant expires after 60 s (with a fake clock);
- a full unlock is left as it was;
- a failed lock produces the "couldn't lock" notice, never a success notice;
- a lock left pending when the app was closed is sent on the next start.

### 7.3 M4 offline copies: sensitive metadata (separate from M5)

**Confirmed at `9df0543`:**
- `gallery.item()` sends `location` (GPS coordinates) and `folder` (the file's physical path
  on the server) for every item.
- M4 keeps the page data exactly as it arrives.
- Photo's offline pages (`library`, `albums`, `album`) therefore put GPS coordinates and
  server paths into AsyncStorage, for up to 600 items per page.

AsyncStorage is private to the app, but:
- it is not encrypted;
- it can be included in device backups;
- it outlives the session for up to 7 days.

Codex's fix named Photo's fields in shared code, and has been reverted. A generic fix must let
the Satellite decide, through its document.

**Proposal** (contract 1.2 is still unreleased, so `offline` can change shape):
1. **Keep only what the page binds.** From the page's own blocks, the client works out which
   fields the page reads: `$.x` bindings, a media-grid's `item` and `viewer` templates, and
   the cursor of `more`. It stores only those fields. This is generic and automatic.
2. **Let the document mark fields to leave out.** A page declares
   `"offline": {"omit": ["location", "folder"]}`. The field names live in Photo's `ui.json`,
   never in shared code.
   - Those fields are never stored.
   - Offline, a viewer field bound to one of them is hidden.
   - The Engine checks that each name is a plain field name.
   - `"offline": true` keeps working and means "omit nothing".
3. **An optional Engine warning, later:** a page with `offline` whose viewer binds a field with
   a sensitive format, such as a future `coordinates` or `path` format, gets a validation
   warning naming the field.
4. **Photo's `ui.json`:** `"offline": {"omit": ["location", "folder"]}` on `library`, `albums`
   and `album`.
5. **Storage moves to `starcore_ui_offline:v2`.** Tidy-up deletes every `v1` entry, so copies
   that already hold GPS data are erased on the first run after the update.
6. **Docs:** "Offline pages" in `docs/ui-contract.md` says the copy is unencrypted app
   storage, and that a Satellite must omit anything it wouldn't want on the device that way.

**Dependency on M5:** none. I recommend shipping it first, as its own commit, because it fixes
data that is already being written.

**Tests:**
- the stored entry holds no `location` or `folder` value;
- unbound fields are dropped;
- `v1` entries are deleted;
- the viewer hides the omitted fields while offline;
- Engine fixtures for `omit`: valid, not a list, not a plain field name;
- the existing M4 tests still pass.

## 8. Revised implementation plan

Each step is its own commit, reviewed before it is committed.

| # | Step | Platforms |
| --- | --- | --- |
| 1 | **Offline omission (7.3):** binding projection, `offline.omit`, `v2` with the `v1` purge, Photo's `ui.json`, docs. Separate from M5. | Engine, Android, contract |
| 2 | **F1 (7.2):** the dedicated web move locks again in `finally`, with the "couldn't lock" notice. | Web (dedicated) |
| 3 | **Server:** the single-action grant (`for: "move_in"`); `media.gallery` 1.1 `resolve`; the Engine reference resolver; `media.vault` v1 declared (`status`, `unlock`, `biometric`, `lock`, `move_in`, no reads); `move_in` with references. | Engine, Locked Folder, Photo |
| 4 | **Contract:** the `secure` action (`media.vault` / `move_in` only), Engine checks including "the document's Satellite is the `media.gallery` provider", fixtures, docs. | Engine, web and Android contract |
| 5 | **Web shared runner:** a client-owned PIN dialog, the single-action grant, the failed-lock notice, refresh. | Web |
| 6 | **Android shared runner:** a generic vault-unlock component (PIN and biometrics) wired through `builtins.tsx`; image eviction; offline copies forgotten for every session; a pending lock sent on the next start. | Android |
| 7 | **Photo `ui.json`:** "Move to Locked Folder" in the viewer and the selection. | Contract (data) |
| 8 | **Checks:** the full suites; end to end on the local demo with a generated PIN, on the web and the emulator; a security review of the whole diff. | All |

## 9. Final security details (approved 2026-11-08)

### 9.1 Checks made at the moment of the move (TOCTOU)

**Confirmed in the code today (`vault.move_in`):**
- Moves run one at a time under `_move_lock`.
- For each photo, `library.get(id)` is read again inside that lock, just before the copy. It
  returns only active photos, not binned ones.
- The original's SHA-256 must start with the photo's id, because Photo ids are content
  hashes. So the bytes copied are the bytes that id names, even if the file was swapped on
  disk.
- If anything fails after the copy, the vault copy and the seal are undone.

**What M5 adds, so nothing changes between the check and the move:**
1. **Checked again at the moment of the move.**
   - The check when the grant is issued (9.2) only decides what may be moved.
   - Inside `_move_lock`, every reference is resolved again through the Engine's resolver,
     immediately before its copy. The resolver looks the provider up in the registry, and
     the provider's `resolve` confirms the item is still active.
   - The move works from that fresh answer: an item binned, erased or already moved since the
     grant is reported in `failed`, and nothing about it changes.
2. **The removal itself checks again, under Photo's own write lock.**
   - `library.remove_moved(id)` will take the library's `_writing` lock and refuse if the photo
     is gone or binned (today it ignores `trashed_at`).
   - `trash`, `erase` and `restore` take the same lock, so a photo can't be binned between the
     last check and its removal.
   - If removal is refused, the vault copy and the seal are undone, as they are today.
3. **One request is never half-authorized.** The grant check (9.2) covers the whole set.
   After that, each item either moves completely or stays where it was, and is reported per
   item.

### 9.2 What the single-move grant is bound to

`POST unlock {"pin", "for": {"operation": "move_in", "items": [references]}}`, and the same
`for` on `biometric/unlock`:
1. The PIN or signature is checked exactly as for a full unlock, with the same attempt
   counting, lockout and `Retry-After`.
2. The references are resolved (7.1). If any fails, no grant is issued and nothing is moved.
3. The server issues a grant `{id, token, operation: "move_in", items, expires}`:
   - `id`: 128 random bits from `secrets.token_urlsafe`;
   - `token`: the requesting session;
   - `items`: the **frozen set of resolved references** (provider and id);
   - `expires`: 60 seconds after issue.

   The answer is `{"grant": id, "expires_at": ...}`.
4. `POST move_in {"grant": id, "items": [references]}`. Under the runtime's lock, and in one
   step, the grant is **taken out of the table**; the request goes ahead only if:
   - it exists and hasn't expired;
   - its token is this request's session;
   - its operation is `move_in`;
   - its item set equals the resolved request set exactly (not a subset, not a superset).

   Any mismatch still uses up the grant, and the request gets `403`.
5. **Replay and concurrency:** taking the grant out and checking it are the same atomic step.
   Of two concurrent requests with the same grant, exactly one gets it and the other finds
   nothing (`403`). A replayed request finds nothing. A grant is never put back, whatever the
   move's outcome.
6. **Revocation:**
   - grants are in memory only, so a restart drops them;
   - changing the PIN, changing the vault location (`forget_all_unlocks`) and a recovery
     drop every grant;
   - an expired grant is purged on the next lookup.

### 9.3 A grant is not an unlock

- Grants live in their own table, separate from the session's unlocks (`_unlocked`).
  Issuing one **doesn't change the vault's unlocked state**:
  - `is_unlocked(token)` stays false;
  - `status` still reports `unlocked: false`;
  - `media`, `media/file`, `upload`, `delete`, `move_out` and `encryption` still refuse the
    session with `403`.
- `move_in` accepts **either** a full unlock (today's behaviour, used by the dedicated
  screens) **or** a matching grant. A grant opens nothing else.
- **With the 15-minute unlock:**
  - If the session is already unlocked, the shared client sees `unlocked: true` in `status`
    and calls `move_in` under that unlock, with no prompt and no grant, then leaves it as it
    was. The person opened the Locked Folder themselves, and it locks by its own rules.
  - Otherwise the client asks for a grant. The session's unlocked state never changes, so the
    shared flow has **nothing to lock again**. A crash, a lost connection or a killed app
    leaves at most an unused grant that can move only the named photos for at most 60 s.
  - The dedicated screens keep their full unlock and lock-again flow (with F1 fixed). They may
    move to grants later.
- **Attempt counters:** a grant issued after a correct PIN resets the counters, exactly like
  a successful unlock.

### 9.4 Offline copies: keep only what is allowed, everywhere (clarifies 7.3)

- **Only allowed data is kept.** What the page's blocks bind is the allowlist; everything
  else is dropped. Allowed means:
  - the fields named by the page's `$.` bindings;
  - templates in a block's `item` and `viewer`, applied to every item;
  - a media-grid's `more` cursor.

  Bindings are followed into nested objects and arrays by their path, so `$.a.b` keeps `a.b`
  and nothing else of `a`.
- **Omissions apply at every depth.** A name in `offline.omit` is removed wherever it
  appears in the kept data: in the page data, in every item, and in every grid page, however
  deeply nested.
  - An omitted name wins over a binding.
  - An item's key fields (`item.key`, and the ids used in image and route templates) can't be
    omitted; the Engine refuses that.
- **All old copies go.** On the app's first start after the update, every key under the old
  prefix `starcore_ui_offline:v1` is deleted, for every server and session, whether listed in
  an index or not. That happens before any offline page can be read, and the new store
  (`v2`) never reads a `v1` key. A failed delete is retried on the next start.
- **Tests:**
  - nested and array data reduced to the bound paths;
  - an omitted name removed at depth 3 and inside grid pages;
  - an omitted key refused by the Engine;
  - `v1` keys for two servers and an unlisted orphan all deleted at start;
  - nothing in the new entry contains a value of `location` or `folder` from a Photo-like
    fixture (in the tests only, never in shared code).

## 10. As built: security review of M5 (2026-11-09)

I reviewed every change since the recovery point (`9df0543..HEAD`) against sections 4, 7 and
9.

**Commits:**

| Commit | What |
| --- | --- |
| `f73155e` | Offline copies keep only bound fields, never omitted ones; `v1` purge |
| `a4b70f7` | F1: the dedicated web move always locks again |
| `96397d5` | Grants, server-resolved references, `media.vault`, checks again at move time |
| `91db080` | The `secure` action in the contract |
| `c7dc2f2` | Web selection fix: never acts on cancelled items |
| `295f335` | Web runner and prompt |
| `c594169` | Android runner, with the Locked Folder's own prompt |
| `5746c52` | Photo's `ui.json` |

**Confirmed by tests:**
- R1, unlocking: only `unlock` and `biometric/unlock` grant, with the same attempt counting
  and lockout.
- R2, the PIN:
  - it is typed only in a client-owned prompt, and the PIN field is emptied on close;
  - the Engine refuses a body, route or form on a `secure` action;
  - on Android, shared code receives only the grant.
- R3, references:
  - resolved through the registry's `media.gallery` provider;
  - forged provider, capability or id refused, and a mixed request moves nothing;
  - only the document Satellite's own items.
- R4, the server alone decides: a locked session without a grant gets `403`.
- R5, locking: grants open nothing, so the shared flows have nothing to lock again; the
  dedicated web flow locks in `finally` (F1).
- R6, no reading: `media.vault` has no read operation, and a grant is refused by every
  reading route.
- R7, after a move: offline copies forgotten for every session, images evicted on Android,
  partial results reported as partial.
- R8, nothing to run on: no provider or no prompt means no control.
- R9, compatibility: additive to 1.2, and the dedicated screens and `photo_ids` are unchanged.
- 9.1 to 9.3: the grant is atomic and single-use, bound to the session, the exact items and
  60 seconds; it is checked again at move time; Photo's library refuses to remove a binned
  photo under its state lock.

**Found and fixed during the review:**
- **Locking and grants:** a session locking now also drops its own pending grants.
  Previously they lived out their 60 seconds.
- **Web selection (`c7dc2f2`):** an action could run on items from a cancelled selection.
- **Android, caught by tests before the device:**
  - the prompt cancelled itself on any re-render;
  - the selection bar rebuilt itself in a loop.

**Accepted, and why:**
- **Security state at move time:** a grant-based move doesn't re-check `security_problem()`.
  This is the same as an unlocked session's moves today, and the window is at most 60 seconds.
- **Sign-out:** it doesn't drop grants or unlocks in memory, but authentication refuses the
  revoked token before any Locked Folder route runs.
- **Resolution before the attempt is counted:** `for` references are resolved first, so a bad
  request costs no PIN attempt. Resolution needs a valid session and tells it no more than
  Photo's own listing already does.

**Not verified on a device:**
- biometric grants (unit tests only: the emulator has no enrolled fingerprint, and its system
  settings are not changed from here);
- the web prompt's look at full size (the browser pane is narrow).

