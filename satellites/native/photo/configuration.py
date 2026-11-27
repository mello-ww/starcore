"""Photo's own configuration: what it exposes, validates and persists.

This is Photo-owned, not Core-owned. The generic satellite configuration
mechanism (docs/satellites/README.md) only needs a satellite to name one of its own
routes "configuration" - everything about which settings exist, their
defaults, validation and persistence belongs to the satellite itself. The
Core never sees any of these settings by name.

None of them describes something running: a saved change is read the next
time it is needed, so nothing is ever waiting on a restart.
"""

from pathlib import Path
import secrets

DEFAULTS = {
    "photo_directory": "",
    "trash_retention_days": 30,
    "source_paths": [],
    "sync_default_path": "camera",
}

SOURCE_PATH_ID_BYTES = 6  # -> 12 hex characters; only needs to be unique among this satellite's own mappings


class ConfigurationError(Exception):
    """Raised when a Photo setting fails validation."""


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
        "developer": True,
        "description": "Where a phone-synced photo or video lands (and which physical album it joins) when "
                        "its phone folder doesn't match any configured source path.",
    },
}


def resolve_physical_path(satellite, phone_folder) -> str:
    """The server-side physical-album path a file from a phone folder belongs under: whichever
    configured source_paths entry's phone_path matches, or sync_default_path when none does
    (including when the phone didn't say what folder it came from). A directory scan/import never
    calls this."""
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
    the Core ever knowing the setting exists."""
    return int(satellite.config.get("trash_retention_days", DEFAULTS["trash_retention_days"]))


def describe(satellite) -> dict:
    """The current settings; what is saved is what is in use (see the module's docstring)."""
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
        for optional in ("type", "developer"):
            if optional in meta:
                setting[optional] = meta[optional]
        settings.append(setting)

    return {
        "settings": settings,
        "restart_required": False,
        "note": None,
    }


def update(engine, satellite, key: str, value) -> dict:
    """Validates and persists a setting, which is then in use straight away."""
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
    else:
        note = f"Saved. Phone-synced media with no matching source path now lands under '{saved}'."

    result = describe(satellite)
    result["note"] = note
    return result
