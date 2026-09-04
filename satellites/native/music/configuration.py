"""Music's own configuration: what it exposes, validates and persists.

This is Music-owned, not Core-owned. The generic satellite configuration
mechanism (docs/satellites.md) only needs a satellite to name one of its own
routes "configuration" - everything about which settings exist, their
defaults, validation and persistence belongs to the satellite itself. The
Core never sees "library" by name.

Unlike Photo Sync's sync_host/sync_port, there is no running listener here
for a setting to fall out of sync with: "library" only ever describes where
the next scan looks by default (see library.py's MusicLibrary._source()), so
a saved change always applies immediately - there is nothing to restart.
"""

from pathlib import Path

DEFAULTS = {"library": "~/Music"}


class ConfigurationError(Exception):
    """Raised when a Music setting fails validation."""


def _validate_directory(value) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        return ""  # empty means "not configured" - scan then requires a source explicitly

    if not Path(text).expanduser().is_absolute():
        raise ConfigurationError("library must be an absolute path (or start with ~)")
    return text


SETTINGS = {
    "library": {
        "validate": _validate_directory,
        "description": "Default directory 'scan' indexes when a request doesn't name one "
                        "explicitly. Must be an absolute path (or start with ~). Leave empty to "
                        "always require one explicitly.",
        "type": "path",
    },
}


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable Music setting")

    return setting["validate"](value)


def describe(satellite) -> dict:
    """The current settings. Nothing here is ever "pending a restart" - the next
    scan simply uses whatever is saved."""
    settings = []

    for key, meta in SETTINGS.items():
        value = satellite.config.get(key, DEFAULTS[key])
        setting = {
            "key": key,
            "value": value,
            "description": meta["description"],
            "live_value": value,
            "pending_restart": False,
        }
        if "type" in meta:
            setting["type"] = meta["type"]
        settings.append(setting)

    return {"settings": settings, "restart_required": False, "note": None}


def update(satellite, key: str, value) -> dict:
    saved = validate(key, value)
    satellite.config.set(key, saved)

    note = (f"Saved. Music will use '{saved}' as the default directory to scan."
            if saved else "Saved. No default directory is configured - scan will require one explicitly.")

    result = describe(satellite)
    result["note"] = note
    return result
