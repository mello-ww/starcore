"""Locked Folder runtime state: PIN verification, per-session unlock state,
and brute-force rate limiting.

The PIN hash is the only thing persisted (data/pin.json, written the same
atomic way every other satellite's index is - see PhotoLibrary._save() for
the same idiom). Everything else here - which sessions are currently
unlocked, and failed-PIN attempt counters - lives in memory only and is
lost on restart. That is deliberate, not an oversight: it means a StarCore
restart always starts every session locked out again, which is the safer
default, and it means a session token (a bearer secret) is never written to
disk a second time anywhere - see docs/satellites/locked_folder.md, "Why unlock state
is memory-only".
"""

from datetime import datetime, timezone
from pathlib import Path
import base64
import json
import math
import os
import secrets
import threading
import time

from starcore import runtime_paths
from starcore.auth import hash_secret

from . import signatures

PIN_MIN_LENGTH = 4
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

_runtimes = {}


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
        # "unreadable" when pin.json exists but can't be parsed: that must
        # never read as "no PIN yet", or anyone could set a new one
        self.pin_unreadable = False
        self._pin = self._load_pin()
        self._unlocked = {}   # session token -> expires (epoch seconds)
        self._attempts = {}   # session token -> {"count": int, "locked_until": float|None}
        self._global = {"count": 0, "lockouts": 0, "locked_until": 0.0}
        self._challenges = {}  # session token -> {"key_id", "challenge", "expires"}
        self._lock = threading.RLock()
        self._sealed = self._load_set(self.sealed_path, "digests")
        self._devices = self._load_devices()

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
        self._unlocked.clear()

    def reset_attempts(self):
        """Clears every session's brute-force attempt/lockout counters -
        called alongside forget_all_unlocks() whenever the protected root
        is cleared or changed (see configuration.py's update() and the
        "delink" route in api.py), since a lockout earned against the old
        configuration has nothing left to protect once it no longer
        applies either."""
        self._attempts.clear()

    # ---------- PIN ----------

    @property
    def pin_set(self) -> bool:
        # an unreadable PIN file still counts as "set": the vault stays
        # locked until an administrator repairs or removes it on the server
        return self._pin is not None or self.pin_unreadable

    def set_pin(self, pin: str):
        if self.pin_unreadable:
            raise ValueError("the stored PIN could not be read - repair or remove pin.json on the server first")
        salt = secrets.token_bytes(16)
        self._pin = {"salt": salt.hex(), "hash": hash_secret(pin, salt)}
        self._save_pin()
        self.forget_all_unlocks()  # a changed PIN revokes every existing unlock
        # and every biometric enrollment, which was authorized by the old PIN
        self.clear_devices()

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
        self.storage_root.mkdir(parents=True, exist_ok=True)
        partial = self.pin_path.with_suffix(".part")
        partial.write_text(json.dumps(self._pin), encoding="utf-8")
        os.replace(partial, self.pin_path)

    # ---------- unlock state (session-aware, memory only) ----------

    def is_unlocked(self, token: str) -> bool:
        if not token:
            return False
        expires = self._unlocked.get(token)
        if expires is None:
            return False
        if expires < time.time():
            del self._unlocked[token]
            return False
        return True

    def unlock(self, token: str, timeout_seconds: int):
        self._unlocked[token] = time.time() + timeout_seconds
        self._attempts.pop(token, None)

    def lock(self, token: str):
        self._unlocked.pop(token, None)

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

    def begin_attempt(self, token: str, max_attempts: int, lockout_seconds: int) -> int:
        """0 when this session may try a PIN now, otherwise the seconds to wait.

        The attempt is counted as a failure straight away and only cleared by
        record_success(), so firing many guesses at once while the slow PIN
        hash runs can't get past the limit."""
        with self._lock:
            now = time.time()
            if self._global["locked_until"] > now:
                return max(1, math.ceil(self._global["locked_until"] - now))

            record = self._attempts.get(token)
            if record is not None and record.get("locked_until"):
                if record["locked_until"] > now:
                    return max(1, math.ceil(record["locked_until"] - now))
                record = None
            if record is None:
                record = self._attempts[token] = {"count": 0, "locked_until": None}

            record["count"] += 1
            if record["count"] >= max_attempts:
                record["count"] = 0
                record["locked_until"] = now + lockout_seconds

            self._global["count"] += 1
            if self._global["count"] >= max_attempts * GLOBAL_ATTEMPT_FACTOR:
                self._global["count"] = 0
                self._global["lockouts"] += 1
                wait = lockout_seconds * 2 ** min(self._global["lockouts"] - 1, 20)
                self._global["locked_until"] = now + min(wait, GLOBAL_MAX_LOCKOUT)
            return 0

    def record_success(self, token: str):
        with self._lock:
            self._attempts.pop(token, None)
            self._global = {"count": 0, "lockouts": 0, "locked_until": 0.0}

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
        with self._lock:
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

    def has_device(self, key_id: str) -> bool:
        with self._lock:
            return isinstance(key_id, str) and key_id in self._devices

    def device_count(self) -> int:
        with self._lock:
            return len(self._devices)

    def remove_device(self, key_id: str) -> bool:
        with self._lock:
            if self._devices.pop(key_id, None) is None:
                return False
            self._save_devices()
            return True

    def clear_devices(self):
        with self._lock:
            self._challenges.clear()
            if self._devices:
                self._devices.clear()
                self._save_devices()

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
            device = self._devices.get(key_id)
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

    def _load_devices(self) -> dict:
        try:
            data = json.loads(self.devices_path.read_text(encoding="utf-8"))
            devices = data.get("devices", {})
            return {key: value for key, value in devices.items()
                    if isinstance(value, dict) and isinstance(value.get("public_key"), str)}
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, AttributeError) as error:
            # fails closed: no device can use biometric unlock until it re-enrolls
            print(f"[WARNING]: {self.devices_path} could not be read ({error}). Biometric unlock is off.")
            return {}

    def _save_devices(self):
        self._save_json(self.devices_path, {"version": 1, "devices": self._devices})

    def _save_json(self, path: Path, data: dict):
        self.storage_root.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(data), encoding="utf-8")
        os.replace(partial, path)
