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
    # "starcore" follows StarCore's global accent; "artwork" (the player follows the cover) and
    # a "#rrggbb" colour are explicit choices for Music only
    "accent": "starcore",
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

# the equalizer's bands in Hz and its presets, the same as both players' (a page names a preset;
# the bands it sets are chosen here)
EQUALIZER_BANDS = (31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
EQUALIZER_PRESETS = {
    "flat": (0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    "bass": (6, 5, 4, 2, 0, 0, 0, 0, 0, 0),
    "treble": (0, 0, 0, 0, 0, 1, 2, 4, 5, 6),
    "vocal": (-2, -2, -1, 1, 3, 4, 3, 1, 0, -1),
    "rock": (4, 3, 2, 0, -1, 0, 2, 3, 4, 4),
    "electronic": (5, 4, 1, 0, -2, 1, 0, 1, 4, 5),
    "jazz": (3, 2, 1, 2, -1, -1, 0, 1, 2, 3),
    "classical": (4, 3, 2, 1, -1, -1, 0, 2, 3, 4),
    "acoustic": (4, 4, 3, 1, 1, 1, 2, 3, 3, 2),
    "loudness": (5, 3, 0, 0, -1, 0, -1, 0, 3, 5),
    "late night": (-2, -1, 0, 1, 2, 2, 1, 0, -2, -3),
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


# Music's colour picker used to start on StarCore's accent, so switching it to "Fixed colour"
# while StarCore was still red stored that red as Music's own colour - and Music then ignored
# every later global accent change. That exact value is read as "follow StarCore" (nothing is
# rewritten in the database); with StarCore on red it looks exactly the same.
PINNED_STARCORE_RED = "#ee444b"


class PreferenceError(ValueError):
    pass


class Preferences:
    def __init__(self, db):
        self.db = db

    def all(self, user: str) -> dict:
        stored = {row["key"]: loads(row["value"]) for row in self.db.all(
            "SELECT key, value FROM preferences WHERE user = ?", (user,))}
        if str(stored.get("accent", "")).lower() == PINNED_STARCORE_RED:
            stored["accent"] = "starcore"
        return {key: stored.get(key, default) for key, default in PREFERENCE_DEFAULTS.items()}

    def get(self, user: str, key: str):
        return self.all(user).get(key)

    def update(self, user: str, changes: dict) -> dict:
        if not isinstance(changes, dict):
            raise PreferenceError("preferences must be an object")
        if isinstance(changes.get("equalizer"), dict):
            changes = {**changes, "equalizer": merge_equalizer(self.get(user, "equalizer"), changes["equalizer"])}
        validated = {key: validate(key, value) for key, value in changes.items()}
        for key, value in validated.items():
            self.db.execute("INSERT INTO preferences (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) "
                            "DO UPDATE SET value = excluded.value", (user, key, dumps(value)))
        return self.all(user)


def merge_equalizer(current: dict, change: dict) -> dict:
    """A change to the equalizer onto its current value, so a page can send one part of it:
    `enabled` or `preamp` alone, a `preset` by name (its bands with it, unless `bands` are sent
    too, as a whole equalizer is), or one `band` (0 to 9) with its `gain`, which makes it custom."""
    merged = {**(current if isinstance(current, dict) else PREFERENCE_DEFAULTS["equalizer"])}
    for key in ("enabled", "preamp", "bands"):
        if key in change:
            merged[key] = change[key]
    if "preset" in change:
        name = str(change["preset"])
        merged["preset"] = name
        if "bands" not in change and name in EQUALIZER_PRESETS:
            merged["bands"] = list(EQUALIZER_PRESETS[name])
    if "band" in change:
        band = change["band"]
        if not isinstance(band, int) or isinstance(band, bool) or not 0 <= band < len(EQUALIZER_BANDS):
            raise PreferenceError(f"'equalizer.band' must be a band from 0 to {len(EQUALIZER_BANDS) - 1}")
        bands = list(merged.get("bands") or [0] * len(EQUALIZER_BANDS))
        bands[band] = change.get("gain", 0)
        merged["bands"] = bands
        merged["preset"] = "custom"
    return merged


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
        if text not in ("starcore", "artwork") and not (len(text) == 7 and text.startswith("#")
                                      and all(char in "0123456789abcdefABCDEF" for char in text[1:])):
            raise PreferenceError("'accent' must be 'starcore', 'artwork' or a #rrggbb colour")
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
