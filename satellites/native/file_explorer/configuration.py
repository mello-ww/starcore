"""File Explorer's own configuration: just its root directory.

Owned entirely by this satellite, exactly like Photo Sync's configuration.py -
the generic mechanism (docs/satellites.md) only needs a route named
"configuration"; the Core never sees the key "root" by name.
"""

from pathlib import Path

from . import paths

DEFAULTS = {"root": "data"}


class ConfigurationError(Exception):
    """Raised when a File Explorer setting fails validation."""


def _validate_root(value) -> str:
    text = str(value).strip()
    if not text:
        raise ConfigurationError("root must not be empty")
    return text


SETTINGS = {
    "root": {
        "validate": _validate_root,
        "description": "Directory this File Explorer browses. Relative paths are resolved inside "
                        "the satellite's own folder; set an absolute path to browse anywhere else. "
                        "This is the hard boundary every request is confined to.",
    },
}


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable File Explorer setting")

    return setting["validate"](value)


def describe(satellite) -> dict:
    settings = []
    for key, meta in SETTINGS.items():
        value = satellite.config.get(key, DEFAULTS[key])
        settings.append({
            "key": key,
            "value": value,
            "description": meta["description"],
            # unlike Photo Sync's listener, there's nothing running to fall out
            # of sync with a saved value - the next request just uses it, so
            # this is never a change waiting on anything
            "live_value": str(paths.storage_root(satellite)),
            "pending_restart": False,
        })

    return {"settings": settings, "restart_required": False, "note": None}


def update(satellite, key: str, value) -> dict:
    saved = validate(key, value)
    satellite.config.set(key, saved)
    result = describe(satellite)
    result["note"] = f"Saved. Now browsing {paths.storage_root(satellite)}."
    return result
