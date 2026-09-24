"""The Locked Folder's own settings: what it exposes, validates and persists.

Deliberately narrow: the PIN itself is never a setting here (it has no
"value" that could ever be safely echoed back through a GET - see
docs/satellites/locked_folder.md) and is instead configured through the satellite's
dedicated "pin" route (api.py). This module only covers what File Explorer's
guard and the unlock/lock routes need to know: where the protected root is,
and the two timing knobs that shape how forgiving or strict it is.
"""

from pathlib import Path

from . import runtime as runtime_module

DEFAULTS = {
    "locked_folder_path": "",
    "session_timeout_seconds": 900,
    "max_pin_attempts": 5,
    "lockout_seconds": 300,
}


class ConfigurationError(Exception):
    """Raised when a Locked Folder setting fails validation."""


def _validate_path(value) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        return ""  # empty means "not configured" - nothing is protected

    expanded = Path(text).expanduser()
    if not expanded.is_absolute():
        raise ConfigurationError("locked_folder_path must be an absolute path (or start with ~)")
    if expanded.parent == expanded:
        raise ConfigurationError("locked_folder_path cannot be a filesystem root")
    return text


def _validate_positive_int(value, name: str, minimum: int, maximum: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigurationError(f"{name} must be a whole number, got '{value}'")
    if not (minimum <= number <= maximum):
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return number


def _validate_session_timeout(value) -> int:
    return _validate_positive_int(value, "session_timeout_seconds", 30, 86400)


def _validate_max_attempts(value) -> int:
    return _validate_positive_int(value, "max_pin_attempts", 1, 20)


def _validate_lockout(value) -> int:
    return _validate_positive_int(value, "lockout_seconds", 10, 3600)


SETTINGS = {
    "locked_folder_path": {
        "validate": _validate_path,
        "description": "The protected storage location. Must be an absolute path (or start with ~). "
                        "Files here are never reachable through File Explorer without unlocking first. "
                        "Leave empty to disable the feature entirely.",
        "type": "path",
    },
    "session_timeout_seconds": {
        "validate": _validate_session_timeout,
        "description": "How long an unlock lasts (seconds) before this session must PIN in again.",
    },
    "max_pin_attempts": {
        "validate": _validate_max_attempts,
        "description": "Incorrect PIN attempts allowed before a temporary lockout.",
    },
    "lockout_seconds": {
        "validate": _validate_lockout,
        "description": "How long a lockout lasts (seconds) after too many incorrect PIN attempts.",
    },
}


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable Locked Folder setting")
    return setting["validate"](value)


def describe(satellite) -> dict:
    settings = []
    for key, meta in SETTINGS.items():
        value = satellite.config.get(key, DEFAULTS[key])
        setting = {
            "key": key,
            "value": value,
            "description": meta["description"],
            # nothing here ever falls out of sync with a running listener the
            # way Photo Sync's host/port can - every one of these settings is
            # read fresh on the very next request, so there is never a change
            # "pending" a restart
            "live_value": value,
            "pending_restart": False,
        }
        if "type" in meta:
            setting["type"] = meta["type"]
        settings.append(setting)

    return {"settings": settings, "restart_required": False, "note": None}


def update(engine, satellite, key: str, value) -> dict:
    saved = validate(key, value)
    previous = satellite.config.get(key, DEFAULTS[key])
    satellite.config.set(key, saved)

    live = runtime_module.runtime(satellite)
    note = None
    if key == "locked_folder_path":
        if saved and saved != previous:
            live.ensure_root_exists()
        if saved != previous:
            # the protected root just changed (or was cleared) - any
            # existing unlock, and any brute-force lockout, was earned
            # under the old configuration and must not silently carry
            # over to the new one (or linger uselessly once there is
            # nothing left to protect)
            live.forget_all_unlocks()
            live.reset_attempts()
        note = (f"Saved. '{saved}' is now the protected Locked Folder location."
                if saved else "Saved. No location is configured - the Locked Folder feature is inactive.")

    result = describe(satellite)
    result["note"] = note
    return result
