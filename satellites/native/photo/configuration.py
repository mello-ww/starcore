"""Photo Sync's own configuration: what it exposes, validates and persists.

This is Photo-owned, not Core-owned. The generic satellite configuration
mechanism (docs/satellites.md) only needs a satellite to name one of its own
routes "configuration" - everything about which settings exist, their
defaults, validation and persistence belongs to the satellite itself. The
Core never sees sync_host or sync_port by name.
"""

from pathlib import Path
import secrets

from . import sync

DEFAULTS = {
    "sync_host": "127.0.0.1",
    "sync_port": 8081,
    "photo_directory": "",
    "trash_retention_days": 30,
    "source_paths": [],
    "sync_default_path": "camera",
}

# settings with nothing running to fall out of sync with (unlike sync_host/
# sync_port, which describe a live listener - see describe()/update() below)
_STATIC_SETTINGS = {"photo_directory", "trash_retention_days", "source_paths", "sync_default_path"}

SOURCE_PATH_ID_BYTES = 6  # -> 12 hex characters; only needs to be unique among this satellite's own mappings


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


def _validate_directory(value) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        return ""  # empty means "not configured" - scan/import then require one explicitly

    if not Path(text).expanduser().is_absolute():
        raise ConfigurationError("photo_directory must be an absolute path (or start with ~)")
    return text


def _validate_server_relative_path(value, setting_name: str) -> str:
    """A path *inside* the library's own storage - never absolute, never
    escaping it with '..' - the same "path is the source of truth" rule
    physical albums rely on (see albums.physical_albums()). Distinct from
    photo_directory above, which names a directory on the machine running
    StarCore, not a location inside the managed library."""
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ConfigurationError(f"{setting_name} must not be empty")
    if text.startswith("/") or text.startswith("~") or (len(text) > 1 and text[1] == ":"):
        raise ConfigurationError(f"{setting_name} must be relative to the library, not an absolute path")

    normalized = text.strip("/")
    segments = normalized.split("/")
    if not normalized or ".." in segments or "." in segments or "" in segments:
        raise ConfigurationError(f"{setting_name} must be a relative path inside the library, without '..'")

    return normalized


def _validate_source_paths(value) -> list:
    if not isinstance(value, list):
        raise ConfigurationError("source_paths must be a list of {phone_path, server_path} mappings")

    seen_ids, seen_phone_paths, seen_server_paths = set(), set(), set()
    validated = []

    for entry in value:
        if not isinstance(entry, dict):
            raise ConfigurationError("each source_paths entry must be an object")

        phone_path = str(entry.get("phone_path", "")).strip()
        if not phone_path:
            raise ConfigurationError("each source_paths entry needs a non-empty 'phone_path'")

        server_path = _validate_server_relative_path(entry.get("server_path"), "each source_paths entry's server_path")

        entry_id = str(entry.get("id") or "").strip()
        while not entry_id or entry_id in seen_ids:
            entry_id = secrets.token_hex(SOURCE_PATH_ID_BYTES)

        if phone_path in seen_phone_paths:
            raise ConfigurationError(f"phone path '{phone_path}' is mapped more than once")
        if server_path in seen_server_paths:
            raise ConfigurationError(f"server path '{server_path}' is mapped more than once")
        seen_ids.add(entry_id)
        seen_phone_paths.add(phone_path)
        seen_server_paths.add(server_path)

        name = str(entry.get("name", "")).strip() or server_path.rsplit("/", 1)[-1]
        validated.append({"id": entry_id, "phone_path": phone_path, "server_path": server_path, "name": name})

    return validated


def _validate_retention_days(value) -> int:
    try:
        days = int(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigurationError(f"trash_retention_days must be a whole number, got '{value}'")
    if days < 1:
        raise ConfigurationError("trash_retention_days must be at least 1")
    return days


SETTINGS = {
    "sync_host": {
        "validate": _validate_host,
        "description": "Address Photo Sync listens on for phone uploads. 0.0.0.0 allows other devices on the local network.",
    },
    "sync_port": {
        "validate": _validate_port,
        "description": "Port Photo Sync listens on.",
    },
    "photo_directory": {
        "validate": _validate_directory,
        "description": "Default directory Photo scans and imports from when a request doesn't name one "
                        "explicitly. Must be an absolute path (or start with ~). Leave empty to always "
                        "require one explicitly.",
        "type": "path",
    },
    "trash_retention_days": {
        "validate": _validate_retention_days,
        "description": "How many days a deleted photo stays in the recycle bin before it is permanently erased.",
    },
    "source_paths": {
        "validate": _validate_source_paths,
        "description": "Explicit phone folder -> server path mappings (e.g. '/Pictures/Screenshots' -> "
                        "'screenshots'). Each one becomes its own physical album; the server path is never "
                        "assumed to match the phone path.",
        "type": "source_paths",
    },
    "sync_default_path": {
        "validate": lambda value: _validate_server_relative_path(value, "sync_default_path"),
        "description": "Where a phone-synced photo or video lands (and which physical album it joins) when "
                        "its phone folder doesn't match any configured source path.",
    },
}


def resolve_physical_path(satellite, phone_folder) -> str:
    """The server-side physical-album path an incoming phone-synced file
    belongs under: whichever configured source_paths entry's phone_path
    matches, or sync_default_path when none does (including when the phone
    didn't say what folder it came from at all - the standalone sync.py
    listener never does). Used only by sync.accept_authenticated_upload();
    a directory scan/import never calls this."""
    phone_folder = str(phone_folder or "").strip()

    for entry in satellite.config.get("source_paths", DEFAULTS["source_paths"]):
        if entry.get("phone_path") == phone_folder:
            return entry["server_path"]

    return str(satellite.config.get("sync_default_path", DEFAULTS["sync_default_path"]))


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable Photo setting")

    return setting["validate"](value)


def trash_retention_days(satellite) -> int:
    """Photo-owned: the recycle bin's own purge routine reads this rather than
    the Core ever knowing the setting exists, same as sync_host/sync_port."""
    return int(satellite.config.get("trash_retention_days", DEFAULTS["trash_retention_days"]))


def describe(satellite) -> dict:
    """The current settings, and whether the running listener still matches them."""
    running = sync.service(satellite)
    settings = []

    for key, meta in SETTINGS.items():
        value = satellite.config.get(key, DEFAULTS[key])

        if key in _STATIC_SETTINGS:
            # photo_directory has no running listener to fall out of sync
            # with - the next scan/import just uses whatever is saved, so
            # there is never a change "pending" the way a listener restart is
            live = value
            pending_restart = False
        else:
            live = {"sync_host": running.host, "sync_port": running.port}[key] if running is not None else None
            # sync_port = 0 means "let the OS choose one" - the live port then never
            # equals the configured value by design, which isn't a change waiting
            # on a restart (the same edge case the Core's own [server].port has)
            pending_restart = live is not None and live != value and not (key == "sync_port" and value == 0)

        setting = {
            "key": key,
            "value": value,
            "description": meta["description"],
            "live_value": live,
            "pending_restart": pending_restart,
        }
        if "type" in meta:
            setting["type"] = meta["type"]
        settings.append(setting)

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

    if key == "photo_directory":
        note = (f"Saved. Photo will use '{saved}' as the default directory to scan and import from."
                if saved else "Saved. No default directory is configured - scan and import will "
                               "require one explicitly.")
    elif key == "trash_retention_days":
        note = f"Saved. A deleted photo now stays in the recycle bin for {saved} day(s) before being erased."
    elif key == "source_paths":
        note = f"Saved {len(saved)} phone -> server path mapping(s)." if saved else "Saved. No phone -> server path mappings are configured - synced media all lands under sync_default_path."
    elif key == "sync_default_path":
        note = f"Saved. Phone-synced media with no matching source path now lands under '{saved}'."
    else:
        note = _apply(engine, satellite)

    # described only after the change has (or hasn't) taken effect, so
    # live_value/pending_restart reflect what actually happened
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
