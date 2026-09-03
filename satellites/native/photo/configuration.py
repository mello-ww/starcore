"""Photo Sync's own configuration: what it exposes, validates and persists.

This is Photo-owned, not Core-owned. The generic satellite configuration
mechanism (docs/satellites.md) only needs a satellite to name one of its own
routes "configuration" - everything about which settings exist, their
defaults, validation and persistence belongs to the satellite itself. The
Core never sees sync_host or sync_port by name.
"""

from . import sync

DEFAULTS = {"sync_host": "127.0.0.1", "sync_port": 8081}


class ConfigurationError(Exception):
    """Raised when a Photo Sync setting fails validation."""


def _validate_host(value) -> str:
    text = str(value).strip()
    if not text:
        raise ConfigurationError("sync_host must not be empty")
    return text


def _validate_port(value) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigurationError(f"sync_port must be a whole number, got '{value}'")
    if not (0 <= port <= 65535):
        raise ConfigurationError("sync_port must be between 0 and 65535")
    return port


SETTINGS = {
    "sync_host": {
        "validate": _validate_host,
        "description": "Address Photo Sync listens on for phone uploads. 0.0.0.0 allows other devices on the local network.",
    },
    "sync_port": {
        "validate": _validate_port,
        "description": "Port Photo Sync listens on.",
    },
}


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable Photo setting")

    return setting["validate"](value)


def describe(satellite) -> dict:
    """The current settings, and whether the running listener still matches them."""
    running = sync.service(satellite)
    settings = []

    for key, meta in SETTINGS.items():
        value = satellite.config.get(key, DEFAULTS[key])
        live = {"sync_host": running.host, "sync_port": running.port}[key] if running is not None else None

        # sync_port = 0 means "let the OS choose one" - the live port then never
        # equals the configured value by design, which isn't a change waiting
        # on a restart (the same edge case the Core's own [server].port has)
        pending_restart = live is not None and live != value and not (key == "sync_port" and value == 0)

        settings.append({
            "key": key,
            "value": value,
            "description": meta["description"],
            "live_value": live,
            "pending_restart": pending_restart,
        })

    return {
        "settings": settings,
        "restart_required": any(setting["pending_restart"] for setting in settings),
        "note": None,
    }


def update(engine, satellite, key: str, value) -> dict:
    """Validates, persists, and restarts the sync listener so the change is real.

    Unlike Mission Control's own host/port (read once at Core startup), Photo
    Sync's listener is a satellite-owned background service independent of the
    API server (see sync.py) - its own start/stop lifecycle hooks can simply be
    called again, so a saved change can actually take effect immediately
    instead of only claiming a restart of the whole StarCore process is needed.
    """
    saved = validate(key, value)
    satellite.config.set(key, saved)
    note = _apply(engine, satellite)

    # described only after the listener has (or hasn't) come back up on the new
    # value, so live_value/pending_restart reflect what actually happened
    result = describe(satellite)
    result["note"] = note
    return result


def _apply(engine, satellite) -> str:
    if not satellite.config.get("sync_enabled", True):
        return "Saved. Photo Sync is currently turned off in config.toml, so nothing needed restarting."

    sync.stop(engine, satellite)
    sync.start(engine, satellite)

    running = sync.service(satellite)
    if running is not None:
        return f"Saved and applied - Photo Sync is now listening on {running.host}:{running.port}."

    return ("Saved, but Photo Sync could not restart with these settings - check that the port "
            "isn't already in use. The previous listener has been stopped.")
