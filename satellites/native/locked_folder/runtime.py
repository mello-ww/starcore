"""Locked Folder runtime state: PIN verification, per-session unlock state,
and brute-force rate limiting.

The PIN hash is the only thing persisted (data/pin.json, written the same
atomic way every other satellite's index is - see PhotoLibrary._save() for
the same idiom). Everything else here - which sessions are currently
unlocked, and failed-PIN attempt counters - lives in memory only and is
lost on restart. That is deliberate, not an oversight: it means a StarCore
restart always starts every session locked out again, which is the safer
default, and it means a session token (a bearer secret) is never written to
disk a second time anywhere - see docs/locked_folder.md, "Why unlock state
is memory-only".
"""

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import secrets
import time

from starcore import runtime_paths
from starcore.auth import hash_secret

PIN_MIN_LENGTH = 4
PIN_MAX_LENGTH = 12

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
    FileExplorer's `entries` route by name - see docs/locked_folder.md,
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
        self._pin = self._load_pin()
        self._unlocked = {}   # session token -> expires (epoch seconds)
        self._attempts = {}   # session token -> {"count": int, "locked_until": float|None}

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
        return self._pin is not None

    def set_pin(self, pin: str):
        salt = secrets.token_bytes(16)
        self._pin = {"salt": salt.hex(), "hash": hash_secret(pin, salt)}
        self._save_pin()
        self.forget_all_unlocks()  # a changed PIN revokes every existing unlock

    def verify_pin(self, pin: str) -> bool:
        if self._pin is None:
            return False
        salt = bytes.fromhex(self._pin["salt"])
        return secrets.compare_digest(hash_secret(pin, salt), self._pin["hash"])

    def _load_pin(self):
        if not self.pin_path.is_file():
            return None
        try:
            data = json.loads(self.pin_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict) or "salt" not in data or "hash" not in data:
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
    # far. A wrong "current_pin" on a PIN change counts against the same
    # counter as a wrong unlock PIN, since both are just as good a way to
    # brute-force the PIN.

    def check_rate_limit(self, token: str, lockout_seconds: int):
        """Returns (allowed: bool, retry_after_seconds: int)."""
        record = self._attempts.get(token)
        if record is None:
            return True, 0
        locked_until = record.get("locked_until")
        if locked_until is None:
            return True, 0
        if locked_until > time.time():
            return False, int(locked_until - time.time()) + 1
        self._attempts.pop(token, None)
        return True, 0

    def record_failure(self, token: str, max_attempts: int, lockout_seconds: int):
        record = self._attempts.setdefault(token, {"count": 0, "locked_until": None})
        record["count"] += 1
        if record["count"] >= max_attempts:
            record["locked_until"] = time.time() + lockout_seconds
            record["count"] = 0

    def record_success(self, token: str):
        self._attempts.pop(token, None)
