"""Music's own configuration: what it exposes, validates and persists.

This is Music-owned, not Core-owned. The generic satellite configuration
mechanism (docs/satellites.md) only needs a satellite to name one of its own
routes "configuration" - everything about which settings exist, their
defaults, validation and persistence belongs to the satellite itself. The
Core never sees "library" by name.

Nothing here runs continuously except the optional scheduled scan, which
reads its interval afresh on every tick, so no saved change ever waits on a
restart.
"""

from pathlib import Path
import re

DEFAULTS = {
    "library": "~/Music",
    "sources": [],
    "exclude": [],
    "min_duration": 0,
    "missing_metadata": "filename",
    "scan_interval": 0,
    "ffmpeg": "ffmpeg",
    "transcode_workers": 2,
    "transcode_cache_mb": 2048,
}

MISSING_METADATA = ("filename", "folders")
LIST_SEPARATOR = re.compile(r"[;\n]+")


class ConfigurationError(Exception):
    """Raised when a Music setting fails validation."""


def _validate_directory(value) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        return ""  # empty means "not configured" - scan then requires a source explicitly

    if not Path(text).expanduser().is_absolute():
        raise ConfigurationError("library must be an absolute path (or start with ~)")
    return text


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        value = LIST_SEPARATOR.split(value)
    if not isinstance(value, list):
        raise ConfigurationError("expected a list")
    return [str(item).strip() for item in value if str(item).strip()]


def _validate_sources(value) -> list:
    sources = _as_list(value)
    if len(sources) > 32:
        raise ConfigurationError("at most 32 additional source folders can be configured")
    for source in sources:
        if not Path(source).expanduser().is_absolute():
            raise ConfigurationError(f"'{source}' must be an absolute path (or start with ~)")
    return list(dict.fromkeys(sources))


def _validate_patterns(value) -> list:
    patterns = _as_list(value)
    if len(patterns) > 64 or any(len(pattern) > 200 for pattern in patterns):
        raise ConfigurationError("at most 64 exclude patterns of up to 200 characters")
    return patterns


def _number(low, high, integer=True):
    def validate(value):
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ConfigurationError(f"expected a number between {low} and {high}")
        if not low <= number <= high:
            raise ConfigurationError(f"expected a number between {low} and {high}")
        return int(number) if integer else number
    return validate


def _choice(options):
    def validate(value):
        if value not in options:
            raise ConfigurationError(f"expected one of {', '.join(options)}")
        return value
    return validate


def _validate_binary(value) -> str:
    text = str(value or "").strip()
    if not text:
        return "ffmpeg"
    if text != "ffmpeg" and not Path(text).expanduser().is_absolute():
        raise ConfigurationError("ffmpeg must be 'ffmpeg' (found on PATH) or an absolute path to the binary")
    if any(char in text for char in "\"'`$|;&<>"):
        raise ConfigurationError("ffmpeg must be a plain path")
    return text


SETTINGS = {
    "library": {
        "validate": _validate_directory,
        "description": "Default directory 'scan' indexes when a request doesn't name one "
                        "explicitly. Must be an absolute path (or start with ~). Leave empty to "
                        "always require one explicitly.",
        "type": "path",
    },
    "sources": {
        "validate": _validate_sources,
        "description": "Additional music folders scanned alongside the library directory, separated by ';'.",
        "type": "path-list",
    },
    "exclude": {
        "validate": _validate_patterns,
        "developer": True,
        "description": "Glob patterns of files or folders never indexed, relative to a source "
                        "(for example '*/Podcasts/*'), separated by ';'.",
        "type": "list",
    },
    "min_duration": {
        "validate": _number(0, 3600),
        "developer": True,
        "description": "Skip audio shorter than this many seconds (0 indexes everything).",
    },
    "missing_metadata": {
        "validate": _choice(MISSING_METADATA),
        "developer": True,
        "description": "How untagged files are named: 'filename' uses the file name, 'folders' reads "
                        "Artist/Album/NN Title from the folder layout.",
        "options": list(MISSING_METADATA),
    },
    "scan_interval": {
        "validate": _number(0, 7 * 24 * 60),
        "developer": True,
        "description": "Rescan every configured source every this many minutes while StarCore runs "
                        "(0 turns scheduled scans off).",
    },
    "ffmpeg": {
        "validate": _validate_binary,
        "developer": True,
        "description": "FFmpeg used for optional transcoding: 'ffmpeg' on PATH or an absolute path. "
                        "Without it every track streams in its original quality.",
    },
    "transcode_workers": {
        "validate": _number(1, 8),
        "developer": True,
        "description": "How many transcodes may run at once.",
    },
    "transcode_cache_mb": {
        "validate": _number(64, 1_000_000),
        "developer": True,
        "description": "Disk space transcoded copies may use before the oldest are removed.",
    },
}


def validate(key: str, value):
    setting = SETTINGS.get(key)
    if setting is None:
        raise ConfigurationError(f"'{key}' is not a configurable Music setting")

    return setting["validate"](value)


def value_of(satellite, key: str):
    value = satellite.config.get(key, DEFAULTS[key])
    return value if value is not None else DEFAULTS[key]


def describe(satellite) -> dict:
    """The current settings. Nothing here is ever "pending a restart"."""
    settings = []

    for key, meta in SETTINGS.items():
        value = value_of(satellite, key)
        if isinstance(value, list):
            value = "; ".join(str(item) for item in value)
        setting = {
            "key": key,
            "value": value,
            "description": meta["description"],
            "live_value": value,
            "pending_restart": False,
        }
        for optional in ("type", "options", "developer"):
            if optional in meta:
                setting[optional] = meta[optional]
        settings.append(setting)

    return {"settings": settings, "restart_required": False, "note": None}


def update(satellite, key: str, value) -> dict:
    saved = validate(key, value)
    satellite.config.set(key, saved)

    if key == "library":
        note = (f"Saved. Music will use '{saved}' as the default directory to scan."
                if saved else "Saved. No default directory is configured - scan will require one explicitly.")
    else:
        note = "Saved. It applies to the next scan or stream."

    result = describe(satellite)
    result["note"] = note
    return result
