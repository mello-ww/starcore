"""Locked Folder runtime state: PIN verification, per-session unlock state,
and brute-force rate limiting.

Persisted next to each other in the satellite's storage root (StarCore's
application-data directory, never the vault itself):
- pin.json      - the PIN hash (format unchanged since the first release);
- attempts.json - failed-PIN counters and lockout deadlines, so a restart
                  never resets a lockout. Sessions appear only as a hash of
                  their token, never the token itself;
- devices.json  - biometric public keys;
- sealed.json   - digests of photos moved in from Photos.

Which sessions are unlocked stays in memory only: a restart locks every
session again, and a session token (a bearer secret) is never written to
disk a second time - see docs/satellites/locked_folder.md, "Why unlock
state is memory-only".

Once the vault is encrypted (see encryption.py), pin.json and devices.json
also carry a "binding": a MAC under a key only the vault key can produce. A
PIN file or device list edited, swapped or deleted outside StarCore then
keeps the vault locked instead of opening it.
"""

from datetime import datetime, timezone
from pathlib import Path
import base64
import hashlib
import json
import math
import os
import secrets
import threading
import time

from starcore import runtime_paths
from starcore.auth import hash_secret

from . import signatures, thumbnails

PIN_MIN_LENGTH = 4
# how long a single-use grant for one move lasts (see issue_grant)
GRANT_SECONDS = 60
PIN_MAX_LENGTH = 12

# Account-wide backstop on top of the per-session limit: per-session counters
# alone can be reset by signing in again for a fresh session. After
# max_pin_attempts * GLOBAL_ATTEMPT_FACTOR wrong PINs from any mix of sessions
# with no correct one in between, every session is refused for lockout_seconds,
# doubling on each further lockout up to GLOBAL_MAX_LOCKOUT.
GLOBAL_ATTEMPT_FACTOR = 4
GLOBAL_MAX_LOCKOUT = 24 * 60 * 60

CHALLENGE_SECONDS = 120     # how long a biometric unlock challenge stays valid
MAX_DEVICE_KEYS = 20        # biometric devices enrolled at once

# a day without a single wrong PIN forgets earlier escalation, so ordinary
# typos spread over weeks never add up to long lockouts
FAILURE_MEMORY = 24 * 60 * 60
ATTEMPTS_VERSION = 1

_runtimes = {}


class SecurityStateError(Exception):
    """The attempt counters could not be saved. No PIN is checked then, since
    an attempt that isn't recorded could be repeated without limit."""


def _empty_counter() -> dict:
    return {"count": 0, "lockouts": 0, "locked_until": 0.0, "last_failure": 0.0}


def _session_key(token: str) -> str:
    # counters are kept per session without ever writing the bearer token itself
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()[:32]


def runtime(satellite):
    """The LockedFolderRuntime for a satellite's own storage root, cached
    per root the same way Photo's library()/albums() factories are (see
    library.py) - one instance per root, reused across every call.

    Also stashes itself on the Satellite instance as `.locked_folder_runtime`
    purely so File Explorer - a different Satellite entirely - can reach
    this exact live instance (to ask "is this path protected, and is this
    session's unlock still valid") without importing this module by name.
    Satellites are otherwise decoupled from one another (see
    docs/satellites.md); this is the one, narrow exception, no different in
    spirit from Mission Control's own configuration picker reaching into
    FileExplorer's `entries` route by name - see docs/satellites/locked_folder.md,
    "How File Explorer recognizes the Locked Folder".
    """
    root = _storage_root(satellite)
    if root not in _runtimes:
        _runtimes[root] = LockedFolderRuntime(satellite, root)
    instance = _runtimes[root]
    satellite.locked_folder_runtime = instance
    return instance


def _storage_root(satellite) -> Path:
    """Where the PIN hash is kept.

    "data" - the historical default, meaning a `data/` folder inside this
    satellite's own directory, inside the Git checkout - now means "use
    StarCore's application-data directory" instead (see
    runtime_paths.data_dir()), with any pre-existing pin.json from that
    historical location migrated over automatically the first time this
    runs. Nobody sets "data" on purpose as a deliberate choice - it is
    simply what's shipped until changed - so treating it as "use whatever
    the current default actually is" is exactly what changing the default
    is supposed to mean; see docs/deployment.md, "Runtime data location".

    Anything else - an explicit absolute path, or an explicit relative one
    other than "data" - is an explicit override and is resolved exactly as
    before, with no migration attempted: that is someone's deliberate
    choice, not a leftover default.
    """
    configured = str(satellite.config.get("storage", "data")).strip()
    if configured == "data":
        legacy_root = satellite.path / "data"
        new_root = runtime_paths.data_dir() / "satellites" / satellite.manifest.name
        effective = runtime_paths.migrate_legacy_file(
            legacy_root / "pin.json", new_root / "pin.json"
        ).parent
        return effective.resolve()

    expanded = Path(configured).expanduser()
    root = expanded if expanded.is_absolute() else satellite.path / expanded
    return root.resolve()


def validate_pin(pin) -> str:
    text = str(pin) if pin is not None else ""
    if not text.isdigit() or not (PIN_MIN_LENGTH <= len(text) <= PIN_MAX_LENGTH):
        raise ValueError(f"a PIN must be {PIN_MIN_LENGTH}-{PIN_MAX_LENGTH} digits")
    return text


class LockedFolderRuntime:
    def __init__(self, satellite, storage_root: Path):
        self.satellite = satellite
        self.storage_root = storage_root
        self.pin_path = storage_root / "pin.json"
        self.sealed_path = storage_root / "sealed.json"
        self.devices_path = storage_root / "devices.json"
        self.attempts_path = storage_root / "attempts.json"
        # "unreadable" when pin.json exists but can't be parsed: that must
        # never read as "no PIN yet", or anyone could set a new one
        self.pin_unreadable = False
        # attempts.json existed but couldn't be read: everyone was locked out
        # for one lockout period instead of starting from zero
        self.attempts_damaged = False
        self._lock = threading.RLock()
        self._pin = self._load_pin()
        self._unlocked = {}   # session token -> expires (epoch seconds)
        # single-use grants for one move, kept apart from unlocks: grant id ->
        # {"token", "operation", "items" (frozenset of (provider, id)), "expires"}
        self._grants = {}
        # video poster frames, memory only - emptied once no session has the vault open
        self.thumbnails = thumbnails.Cache()
        self._attempts, self._global, self._recovery = self._load_attempts()
        self._challenges = {}  # session token -> {"key_id", "challenge", "expires"}
        self._sealed = self._load_set(self.sealed_path, "digests")
        self._devices, self._devices_binding = self._load_devices()
        self.migration = None  # set by encryption.py while an encryption run is going

    # ---------- the protected root ----------

    @property
    def configured_root(self):
        """The resolved Locked Folder path, or None when nothing has been
        configured yet - the same "empty means not configured" convention
        Photo's own photo_directory setting uses."""
        raw = str(self.satellite.config.get("locked_folder_path", "") or "").strip()
        if not raw:
            return None
        return Path(raw).expanduser().resolve()

    def protects(self, path: Path) -> bool:
        """True if `path` is the Locked Folder root itself, or lives inside
        it. False (nothing to guard) when no root is configured at all."""
        root = self.configured_root
        if root is None:
            return False
        try:
            return path == root or path.is_relative_to(root)
        except ValueError:
            return False

    def ensure_root_exists(self):
        root = self.configured_root
        if root is not None:
            root.mkdir(parents=True, exist_ok=True)

    def forget_all_unlocks(self):
        """Called whenever the protected root or the PIN changes - either
        one means every existing unlock was granted under a configuration
        that no longer applies, so none of them should silently carry over."""
        with self._lock:
            self._unlocked.clear()
            self._grants.clear()
        self.thumbnails.clear()

    def reset_attempts(self):
        """Clears every session's own attempt counters - called alongside
        forget_all_unlocks() when the protected root changes (configuration.py's
        update()), which already needed an unlocked session once a PIN is
        set. The account-wide counter is left alone: only a correct PIN (or
        the recovery key) clears that."""
        with self._lock:
            self._attempts.clear()
            self._try_save_attempts()

    # ---------- the vault's encryption, as far as the PIN is concerned ----------

    def vault_encrypted(self) -> bool:
        """Whether the configured vault holds an encryption keyring - cheap,
        and true even when the key itself can't be reached right now."""
        from . import encryption
        return encryption.is_encrypted(self.configured_root)

    def binder(self):
        """The configured vault's binding function, None for a vault that
        isn't encrypted. Raises encryption.KeyProblem when the vault is
        encrypted but its key can't be used."""
        from . import encryption
        return encryption.binder(self)

    def security_problem(self):
        """None when the PIN can be checked normally, otherwise why not:
        pin_unreadable, pin_tampered, or one of encryption.KeyProblem's codes.
        Every route that checks a PIN or a biometric signature asks first, so
        damaged or edited security state never reads as permission."""
        if self.pin_unreadable:
            return "pin_unreadable"
        from . import encryption
        try:
            bind = self.binder()
        except encryption.KeyProblem as problem:
            return problem.code
        if bind is None:
            return None
        with self._lock:
            record = self._pin
        if record is None:
            return "pin_tampered"   # the vault is encrypted, so a PIN was set
        expected = bind("pin", {"salt": record.get("salt"), "hash": record.get("hash")})
        if not secrets.compare_digest(str(record.get("binding", "")), expected):
            return "pin_tampered"
        return None

    # ---------- PIN ----------

    @property
    def pin_set(self) -> bool:
        # an unreadable PIN file still counts as "set": the vault stays
        # locked until an administrator repairs or removes it on the server.
        # So does an encrypted vault whose pin.json went missing.
        return self._pin is not None or self.pin_unreadable or self.vault_encrypted()

    def pin_set_at(self):
        """When pin.json was last written (ISO 8601, UTC), or None without one. Read from the
        file's own timestamp: the PIN record itself carries no date, and its format stays as is."""
        try:
            written = self.pin_path.stat().st_mtime
        except OSError:
            return None
        return datetime.fromtimestamp(written, timezone.utc).isoformat(timespec="seconds")

    def set_pin(self, pin: str, bind=None):
        """Sets a new PIN. `bind` is given by a recovery-key reset, which proved
        it holds the vault key; otherwise the vault's own binder is used."""
        if self.pin_unreadable and bind is None:
            raise ValueError("the stored PIN could not be read - repair or remove pin.json on the server first")
        if bind is None:
            bind = self.binder()  # raises KeyProblem: never re-PIN a vault whose key is unreachable
        salt = secrets.token_bytes(16)
        record = {"salt": salt.hex(), "hash": hash_secret(pin, salt)}
        if bind is not None:
            record["binding"] = bind("pin", {"salt": record["salt"], "hash": record["hash"]})
        with self._lock:
            self._pin = record
            self._save_pin()
            self.pin_unreadable = False
        self.forget_all_unlocks()  # a changed PIN revokes every existing unlock
        # and every biometric enrollment, which was authorized by the old PIN
        self.clear_devices(bind)

    def bind_existing(self, bind):
        """Adds bindings to the current pin.json and devices.json, without
        changing the PIN or any device - done once when a vault is encrypted."""
        with self._lock:
            if self._pin is not None:
                self._pin = dict(self._pin, binding=bind("pin", {"salt": self._pin["salt"],
                                                                 "hash": self._pin["hash"]}))
                self._save_pin()
            self._save_devices(bind)

    def verify_pin(self, pin: str) -> bool:
        if self._pin is None:
            return False
        try:
            salt = bytes.fromhex(self._pin["salt"])
            expected = str(self._pin["hash"])
        except (TypeError, ValueError):
            return False
        return secrets.compare_digest(hash_secret(pin, salt), expected)

    def _load_pin(self):
        # the format (hex salt + PBKDF2 hash, see starcore.auth.hash_secret)
        # is unchanged; only a file that exists but can't be read is now
        # treated as "set but unusable" instead of "no PIN"
        if not self.pin_path.is_file():
            return None
        try:
            data = json.loads(self.pin_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("salt"), str) or not isinstance(data.get("hash"), str):
            print(f"[WARNING]: Locked Folder PIN file {self.pin_path} is unreadable. "
                  f"The Locked Folder stays locked until it is repaired or removed.")
            self.pin_unreadable = True
            return None
        return data

    def _save_pin(self):
        self._save_json(self.pin_path, self._pin)

    # ---------- unlock state (session-aware, memory only) ----------

    def is_unlocked(self, token: str) -> bool:
        if not token:
            return False
        expires = self._unlocked.get(token)
        if expires is None:
            return False
        if expires < time.time():
            del self._unlocked[token]
            if not self._unlocked:
                self.thumbnails.clear()
            return False
        return True

    def unlock(self, token: str, timeout_seconds: int):
        self._unlocked[token] = time.time() + timeout_seconds
        self._attempts.pop(token, None)

    def lock(self, token: str):
        with self._lock:
            # a lock ends everything this session holds: its unlock, and any grant not used yet
            for grant_id in [grant_id for grant_id, grant in self._grants.items() if grant["token"] == token]:
                del self._grants[grant_id]
        self._unlocked.pop(token, None)
        if not self._unlocked:
            self.thumbnails.clear()

    # ---------- single-use grants (memory only) ----------

    def issue_grant(self, token: str, operation: str, items) -> tuple:
        """A grant for `token` to run `operation` once on exactly `items` ((provider, id)
        pairs), within GRANT_SECONDS: (grant id, ISO expiry). It is not an unlock -
        is_unlocked() stays as it was, and nothing but that operation accepts it."""
        grant_id = secrets.token_urlsafe(16)  # 128 random bits
        expires = time.time() + GRANT_SECONDS
        with self._lock:
            self._drop_expired_grants()
            self._grants[grant_id] = {"token": token, "operation": operation,
                                      "items": frozenset(items), "expires": expires}
        return grant_id, datetime.fromtimestamp(expires, tz=timezone.utc).isoformat(timespec="seconds")

    def take_grant(self, grant_id, token: str, operation: str, items) -> bool:
        """Uses up a grant: it is taken out of the table and checked in one step under the lock,
        so of two requests presenting it only one finds it, and a replay finds nothing. True
        only when it exists, hasn't expired, belongs to `token`, is for `operation` and covers
        exactly `items`; whatever the answer, the grant is gone."""
        if not isinstance(grant_id, str) or not grant_id:
            return False
        with self._lock:
            grant = self._grants.pop(grant_id, None)
            self._drop_expired_grants()
        return bool(
            grant is not None
            and grant["expires"] >= time.time()
            and token and secrets.compare_digest(grant["token"], token)
            and grant["operation"] == operation
            and grant["items"] == frozenset(items)
        )

    def _drop_expired_grants(self):
        now = time.time()
        for grant_id in [grant_id for grant_id, grant in self._grants.items() if grant["expires"] < now]:
            del self._grants[grant_id]

    def expires_at(self, token: str):
        """An ISO timestamp for when this session's unlock expires, or None
        if it isn't (or no longer is) unlocked at all."""
        expires = self._unlocked.get(token)
        if expires is None or expires < time.time():
            return None
        return datetime.fromtimestamp(expires, tz=timezone.utc).isoformat(timespec="seconds")

    # ---------- brute-force protection ----------
    #
    # Keyed by session token: reaching any of these routes at all already
    # required a valid StarCore session (see server.py's _authorized()), so
    # the realistic threat this defends against is someone in possession of
    # that session (a stolen cookie/bearer token, or a shared machine) who
    # doesn't know the PIN - not an anonymous attacker, who never gets this
    # far. A wrong "current_pin" on a PIN change, and a failed biometric
    # signature, count against the same counter as a wrong unlock PIN.
    #
    # Since signing in again gives a fresh session (and a fresh per-session
    # counter), an account-wide counter backs it up - see GLOBAL_ATTEMPT_FACTOR.
    #
    # Every counter is written to attempts.json before the PIN is checked, so
    # neither a restart nor a crash mid-check forgets an attempt. The recovery
    # key has a counter of its own (kind="recovery"): a PIN lockout must not
    # stop the owner from recovering, and a recovery key can't be guessed.

    def begin_attempt(self, token: str, max_attempts: int, lockout_seconds: int, kind: str = "pin") -> int:
        """0 when this session may try now, otherwise the seconds to wait.

        The attempt is counted as a failure straight away and only cleared by
        record_success(), so firing many guesses at once while the slow PIN
        hash runs can't get past the limit. Raises SecurityStateError, and
        allows nothing, when the counters can't be saved."""
        max_attempts = max(1, int(max_attempts))
        lockout_seconds = max(1, int(lockout_seconds))
        with self._lock:
            now = time.time()
            shared = self._recovery if kind == "recovery" else self._global
            self._decay(shared, now)
            if shared["locked_until"] > now:
                return max(1, math.ceil(shared["locked_until"] - now))

            if kind == "pin":
                key = _session_key(token)
                record = self._attempts.get(key)
                if record is not None and record.get("locked_until"):
                    if record["locked_until"] > now:
                        return max(1, math.ceil(record["locked_until"] - now))
                    record = None
                if record is None:
                    record = self._attempts[key] = {"count": 0, "locked_until": 0.0, "last": now}
                record["count"] += 1
                record["last"] = now
                if record["count"] >= max_attempts:
                    record["count"] = 0
                    record["locked_until"] = now + lockout_seconds

            factor = 1 if kind == "recovery" else GLOBAL_ATTEMPT_FACTOR
            shared["count"] += 1
            shared["last_failure"] = now
            if shared["count"] >= max_attempts * factor:
                shared["count"] = 0
                shared["lockouts"] += 1
                wait = min(lockout_seconds * 2 ** min(shared["lockouts"] - 1, 20), GLOBAL_MAX_LOCKOUT)
                shared["locked_until"] = now + wait
                what = "recovery-key" if kind == "recovery" else "PIN"
                print(f"[WARNING]: Locked Folder: too many incorrect {what} attempts - "
                      f"locked for {int(wait)}s (lockout {shared['lockouts']}).")
            self._save_attempts()
            return 0

    def record_success(self, token: str, kind: str = "pin"):
        with self._lock:
            if kind == "recovery":
                # the recovery key proves ownership, so every counter starts over
                self._recovery = _empty_counter()
                self._global = _empty_counter()
                self._attempts.clear()
            else:
                self._attempts.pop(_session_key(token), None)
                self._global = _empty_counter()
            self._try_save_attempts()

    def lockout_status(self) -> dict:
        """What an administrator may see about the counters - no tokens, no PINs."""
        with self._lock:
            now = time.time()
            self._decay(self._global, now)
            locked_until = self._global["locked_until"]
            return {
                "retry_after": max(0, math.ceil(locked_until - now)) if locked_until > now else 0,
                "failed_attempts": self._global["count"],
                "lockouts": self._global["lockouts"],
                "state_damaged": self.attempts_damaged,
            }

    @staticmethod
    def _decay(counter: dict, now: float):
        if counter["locked_until"] <= now and counter["last_failure"] and now - counter["last_failure"] > FAILURE_MEMORY:
            counter.update(_empty_counter())

    def _load_attempts(self):
        """(per-session, account-wide, recovery) counters from attempts.json.

        A missing file is a fresh start. A file that exists but can't be read
        is never a fresh start: everyone is locked out for one lockout
        period, then the counters start over - so a damaged file can neither
        reset a lockout nor lock the owner out for good."""
        try:
            data = json.loads(self.attempts_path.read_text(encoding="utf-8"))
            sessions, shared, recovery = self._parse_attempts(data)
        except FileNotFoundError:
            return {}, _empty_counter(), _empty_counter()
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            now = time.time()
            wait = max(1, int(self.satellite.config.get("lockout_seconds", 300)))
            print(f"[WARNING]: Locked Folder attempt counters ({self.attempts_path.name}) could not be read. "
                  f"Every session is locked out for {wait}s before PINs are accepted again.")
            self.attempts_damaged = True
            shared = dict(_empty_counter(), lockouts=1, locked_until=now + wait, last_failure=now)
            self._attempts, self._global, self._recovery = {}, shared, dict(shared)
            self._try_save_attempts()
            return {}, shared, dict(shared)

        # a clock that jumped ahead (and back) must not stretch a lockout
        # beyond the longest one this ever hands out
        ceiling = time.time() + GLOBAL_MAX_LOCKOUT
        for counter in [shared, recovery, *sessions.values()]:
            counter["locked_until"] = min(counter["locked_until"], ceiling)
        return sessions, shared, recovery

    @staticmethod
    def _parse_attempts(data):
        if not isinstance(data, dict) or data.get("version") != ATTEMPTS_VERSION:
            raise ValueError("unknown attempts format")

        def counter(raw):
            if not isinstance(raw, dict):
                raise ValueError("bad counter")
            parsed = _empty_counter()
            for field in parsed:
                value = raw.get(field, 0)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value != value:
                    raise ValueError("bad counter")
                parsed[field] = type(parsed[field])(value)
            return parsed

        sessions = {}
        raw_sessions = data["sessions"]
        if not isinstance(raw_sessions, dict):
            raise ValueError("bad sessions")
        for key, raw in raw_sessions.items():
            if not isinstance(key, str) or not isinstance(raw, dict):
                raise ValueError("bad session")
            values = [raw.get("count", 0), raw.get("locked_until", 0), raw.get("last", 0)]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 for v in values):
                raise ValueError("bad session")
            sessions[key] = {"count": int(values[0]), "locked_until": float(values[1]), "last": float(values[2])}
        return sessions, counter(data["global"]), counter(data["recovery"])

    def _save_attempts(self):
        """Writes the counters durably, or raises SecurityStateError."""
        now = time.time()
        # sessions with nothing pending are forgotten after a day
        for key in [key for key, record in self._attempts.items()
                    if record["locked_until"] <= now and now - record.get("last", 0) > FAILURE_MEMORY]:
            del self._attempts[key]
        try:
            self._save_json(self.attempts_path, {
                "version": ATTEMPTS_VERSION,
                "global": self._global,
                "recovery": self._recovery,
                "sessions": self._attempts,
            }, durable=True)
        except OSError as error:
            print(f"[WARNING]: Locked Folder attempt counters could not be saved ({type(error).__name__}). "
                  f"PINs are refused until they can be.")
            raise SecurityStateError("the attempt counters could not be saved") from error

    def _try_save_attempts(self):
        try:
            self._save_attempts()
        except SecurityStateError:
            pass  # counters stay as strict as they are in memory

    # ---------- media moved in from Photos ----------
    #
    # SHA-256 digests of files moved into the vault from the Photo library,
    # so Photo can refuse to take them back in through a phone sync or a
    # directory import while they're private. Only the digest is kept, never
    # a name or path.

    def is_sealed(self, digest: str) -> bool:
        with self._lock:
            return digest in self._sealed

    def seal(self, digest: str):
        with self._lock:
            if digest not in self._sealed:
                self._sealed.add(digest)
                self._save_json(self.sealed_path, {"version": 1, "digests": sorted(self._sealed)})

    def unseal(self, digest: str):
        with self._lock:
            if digest in self._sealed:
                self._sealed.discard(digest)
                self._save_json(self.sealed_path, {"version": 1, "digests": sorted(self._sealed)})

    # ---------- biometric devices ----------
    #
    # A device enrolls an RSA public key whose private half never leaves the
    # phone's Keystore and only signs after a biometric match. Unlocking
    # means signing a fresh, single-use server challenge, verified here -
    # so a biometric "success" reported by a client is never trusted alone.

    def add_device(self, public_key_der: bytes, label: str) -> str:
        signatures.parse_public_key(public_key_der)  # raises ValueError on anything unusable
        trusted = self._trusted_devices()  # never re-sign entries nobody can vouch for
        with self._lock:
            self._devices = trusted
            if len(self._devices) >= MAX_DEVICE_KEYS:
                raise ValueError(f"at most {MAX_DEVICE_KEYS} devices can use biometric unlock")
            key_id = secrets.token_hex(12)
            self._devices[key_id] = {
                "public_key": base64.b64encode(public_key_der).decode("ascii"),
                "label": (str(label or "").strip()[:80] or "Device"),
                "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            self._save_devices()
            return key_id

    def _trusted_devices(self) -> dict:
        """The enrolled devices, or none at all when the vault is encrypted
        and devices.json doesn't carry a valid binding - so a key added to the
        file by hand can never unlock anything."""
        from . import encryption
        with self._lock:
            devices = dict(self._devices)
            binding = self._devices_binding
        if not devices:
            return devices
        try:
            bind = self.binder()
        except encryption.KeyProblem:
            return {}
        if bind is None:
            return devices
        if not secrets.compare_digest(str(binding or ""), bind("devices", devices)):
            return {}
        return devices

    def has_device(self, key_id: str) -> bool:
        return isinstance(key_id, str) and key_id in self._trusted_devices()

    def device_count(self) -> int:
        return len(self._trusted_devices())

    def remove_device(self, key_id: str) -> bool:
        trusted = self._trusted_devices()
        with self._lock:
            self._devices = trusted
            if self._devices.pop(key_id, None) is None:
                return False
            self._save_devices()
            return True

    def clear_devices(self, bind=None):
        with self._lock:
            self._challenges.clear()
            self._devices.clear()
            self._save_devices(bind)

    def new_challenge(self, token: str, key_id: str) -> str:
        with self._lock:
            challenge = secrets.token_urlsafe(32)
            self._challenges[token] = {"key_id": key_id, "challenge": challenge,
                                       "expires": time.time() + CHALLENGE_SECONDS}
            return challenge

    def verify_signature(self, token: str, key_id: str, challenge: str, signature: bytes) -> bool:
        """True only for a signature, by this device's enrolled key, over the
        challenge this same session was just given. Each challenge is used up
        by the first attempt, right or wrong."""
        with self._lock:
            issued = self._challenges.pop(token, None)
        device = self._trusted_devices().get(key_id)
        if issued is None or device is None or issued["expires"] < time.time():
            return False
        if not isinstance(challenge, str) or issued["key_id"] != key_id:
            return False
        if not secrets.compare_digest(issued["challenge"].encode(), challenge.encode("utf-8", "replace")):
            return False
        try:
            public_key = signatures.parse_public_key(base64.b64decode(device["public_key"]))
        except ValueError:
            return False
        return signatures.verify(public_key, challenge.encode("utf-8"), signature)

    # ---------- small JSON stores next to pin.json ----------

    def _load_set(self, path: Path, key: str) -> set:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {str(item) for item in data.get(key, [])}
        except FileNotFoundError:
            return set()
        except (OSError, ValueError, AttributeError) as error:
            print(f"[WARNING]: {path} could not be read ({error}). Treating it as empty.")
            return set()

    def _load_devices(self):
        """(devices, binding) from devices.json."""
        try:
            data = json.loads(self.devices_path.read_text(encoding="utf-8"))
            devices = data.get("devices", {})
            binding = data.get("binding")
            return ({key: value for key, value in devices.items()
                     if isinstance(value, dict) and isinstance(value.get("public_key"), str)},
                    binding if isinstance(binding, str) else None)
        except FileNotFoundError:
            return {}, None
        except (OSError, ValueError, AttributeError) as error:
            # fails closed: no device can use biometric unlock until it re-enrolls
            print(f"[WARNING]: {self.devices_path} could not be read ({type(error).__name__}). Biometric unlock is off.")
            return {}, None

    def _save_devices(self, bind=None):
        """Saves the device list, bound to the vault key when the vault is
        encrypted. Without a usable key no binding is written, so the list
        stays untrusted rather than trusted by accident."""
        from . import encryption
        if bind is None:
            try:
                bind = self.binder()
            except encryption.KeyProblem:
                bind = None
        data = {"version": 1, "devices": self._devices}
        self._devices_binding = bind("devices", self._devices) if bind is not None else None
        if self._devices_binding is not None:
            data["binding"] = self._devices_binding
        self._save_json(self.devices_path, data)

    def _save_json(self, path: Path, data: dict, durable: bool = False):
        """Atomic replace; `durable` also flushes to disk first, for security
        state a power cut must not roll back."""
        self.storage_root.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
        try:
            with open(partial, "w", encoding="utf-8") as file:
                file.write(json.dumps(data))
                if durable:
                    file.flush()
                    os.fsync(file.fileno())
            os.replace(partial, path)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
