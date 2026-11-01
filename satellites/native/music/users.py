"""Whose request this is. Every piece of listener data is kept per account."""

from .db import dumps, loads

# a StarCore without an account yet is open by the Core's own design (see auth.py);
# its data then belongs to this one local listener, and moves nowhere once accounts exist
LOCAL_LISTENER = "local"


class NotSignedIn(Exception):
    pass


def current_user(request) -> str:
    auth = request.engine.auth
    if not auth.is_bootstrapped:
        return LOCAL_LISTENER
    username = auth.session_username(request.token) if hasattr(auth, "session_username") else ""
    if not username:
        raise NotSignedIn("authentication required")
    return username


def current_session(request) -> str:
    auth = request.engine.auth
    if not auth.is_bootstrapped or not hasattr(auth, "session_id"):
        return ""
    return auth.session_id(request.token)


PREFERENCE_DEFAULTS = {
    "theme": "system",
    "accent": "artwork",
    "density": "comfortable",
    "streaming_quality": "original",
    "cellular_quality": "normal",
    "transcode_format": "opus",
    "replaygain": "album",
    "normalize": False,
    "crossfade": 0,
    "gapless": True,
    "equalizer": {"enabled": False, "preset": "flat", "bands": [0] * 10, "preamp": 0},
    "bass_boost": 0,
    "speed": 1.0,
    "pitch": 0,
    "preserve_pitch": True,
    "lyrics_offset": 0,
    "lyrics_provider": "local",
    "history_enabled": True,
    "discovery_enabled": True,
    "queue_end": "stop",
    "download_network": "wifi",
    "download_quality": "original",
    "cache_limit_mb": 2048,
    "visualizer": "off",
    "scrobbling": False,
}

PREFERENCE_TYPES = {
    "theme": ("system", "dark", "light"),
    "accent": None,
    "density": ("comfortable", "compact"),
    "streaming_quality": ("original", "high", "normal", "low"),
    "cellular_quality": ("original", "high", "normal", "low"),
    "download_quality": ("original", "high", "normal", "low"),
    "transcode_format": ("opus", "aac", "mp3"),
    "replaygain": ("off", "track", "album"),
    "queue_end": ("stop", "repeat", "autoplay"),
    "download_network": ("wifi", "any"),
    "lyrics_provider": ("local", "off"),
    "visualizer": ("off", "bars", "wave"),
}


class PreferenceError(ValueError):
    pass


class Preferences:
    def __init__(self, db):
        self.db = db

    def all(self, user: str) -> dict:
        stored = {row["key"]: loads(row["value"]) for row in self.db.all(
            "SELECT key, value FROM preferences WHERE user = ?", (user,))}
        return {key: stored.get(key, default) for key, default in PREFERENCE_DEFAULTS.items()}

    def get(self, user: str, key: str):
        return self.all(user).get(key)

    def update(self, user: str, changes: dict) -> dict:
        if not isinstance(changes, dict):
            raise PreferenceError("preferences must be an object")
        validated = {key: validate(key, value) for key, value in changes.items()}
        for key, value in validated.items():
            self.db.execute("INSERT INTO preferences (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) "
                            "DO UPDATE SET value = excluded.value", (user, key, dumps(value)))
        return self.all(user)


def validate(key: str, value):
    if key not in PREFERENCE_DEFAULTS:
        raise PreferenceError(f"'{key}' is not a music preference")
    default = PREFERENCE_DEFAULTS[key]
    allowed = PREFERENCE_TYPES.get(key)
    if allowed:
        if value not in allowed:
            raise PreferenceError(f"'{key}' must be one of {', '.join(allowed)}")
        return value
    if key == "accent":
        text = str(value)
        if text != "artwork" and not (len(text) == 7 and text.startswith("#")
                                      and all(char in "0123456789abcdefABCDEF" for char in text[1:])):
            raise PreferenceError("'accent' must be 'artwork' or a #rrggbb colour")
        return text
    if key == "equalizer":
        if not isinstance(value, dict):
            raise PreferenceError("'equalizer' must be an object")
        bands = value.get("bands", [0] * 10)
        if not isinstance(bands, list) or len(bands) != 10:
            raise PreferenceError("'equalizer.bands' must hold ten gains")
        return {"enabled": bool(value.get("enabled")), "preset": str(value.get("preset", "custom"))[:40],
                "bands": [_bounded(band, -12, 12) for band in bands], "preamp": _bounded(value.get("preamp", 0), -12, 12)}
    if isinstance(default, bool):
        return bool(value)
    if key == "speed":
        return _bounded(value, 0.5, 2.0)
    if key == "pitch":
        return _bounded(value, -12, 12)
    if key == "crossfade":
        return _bounded(value, 0, 12)
    if key == "bass_boost":
        return _bounded(value, 0, 12)
    if key == "lyrics_offset":
        return int(_bounded(value, -30000, 30000))
    if key == "cache_limit_mb":
        return int(_bounded(value, 100, 200_000))
    return value


def _bounded(value, low, high) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise PreferenceError(f"expected a number between {low} and {high}")
    if number != number:
        raise PreferenceError("expected a number")
    return round(min(max(number, low), high), 2)
