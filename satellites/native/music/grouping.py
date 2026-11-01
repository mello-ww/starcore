"""How tracks become artists, albums and releases, and how their quality is described."""

import hashlib
import re
import unicodedata

ID_LENGTH = 16
UNKNOWN_ALBUM = "Unknown album"
UNKNOWN_ARTIST = "Unknown artist"
VARIOUS_ARTISTS = "Various Artists"

# "&" and "," are left alone: too many real artist names contain them
ARTIST_SEPARATORS = re.compile(r"\s*(?:;|\s/\s|\bfeat\.(?=\s)|\bfeat\b|\bft\.(?=\s)|\bfeaturing\b)\s*", re.IGNORECASE)
FEATURED_IN_TITLE = re.compile(r"[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s+([^\)\]]+)[\)\]]", re.IGNORECASE)


def digest(*parts) -> str:
    joined = "\x00".join(str(part) for part in parts).lower()
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:ID_LENGTH]


def normalize(text) -> str:
    """Case, accent and punctuation folded, for matching and duplicate detection."""
    if not text:
        return ""
    folded = unicodedata.normalize("NFKD", str(text))
    folded = "".join(char for char in folded if not unicodedata.combining(char)).lower()
    folded = re.sub(r"[\(\[].*?[\)\]]", " ", folded)
    return re.sub(r"[^\w]+", " ", folded).strip()


def artist_id(name: str) -> str:
    return digest("artist", normalize(name) or name)


def album_id(artist: str, album: str) -> str:
    # the same formula the JSON index used, so existing cover art caches stay valid
    return digest(artist, album)


def split_artists(values: list, title: str = None) -> list:
    """Primary artist first, then featured ones, without repeats."""
    names = []
    for value in values or []:
        for part in ARTIST_SEPARATORS.split(value or ""):
            part = part.strip()
            if part and part.lower() not in (name.lower() for name in names):
                names.append(part)

    for match in FEATURED_IN_TITLE.finditer(title or ""):
        for part in re.split(r"\s*(?:,|&|and)\s*", match.group(1)):
            part = part.strip()
            if part and part.lower() not in (name.lower() for name in names):
                names.append(part)
    return names


def album_identity(tags: dict) -> tuple:
    """(album name, album artist) a track groups under."""
    album = tags.get("album") or UNKNOWN_ALBUM
    album_artist = tags.get("album_artist")
    if not album_artist:
        if tags.get("compilation"):
            album_artist = VARIOUS_ARTISTS
        else:
            artists = split_artists([tags.get("artist")] if tags.get("artist") else [])
            album_artist = artists[0] if artists else UNKNOWN_ARTIST
    return album, album_artist


def release_type(tracks: int, duration: float, compilation: bool) -> str:
    if compilation:
        return "compilation"
    duration = duration or 0
    if tracks <= 3 and duration < 15 * 60:
        return "single"
    if tracks <= 6 and duration < 30 * 60:
        return "ep"
    return "album"


def quality(codec, sample_rate, bit_depth, bitrate, lossless) -> dict:
    """A badge is only earned by what the stream actually is, never by the file extension."""
    hires = bool(lossless and ((bit_depth or 0) >= 24 or (sample_rate or 0) > 48000))
    if hires:
        label = f"Hi-Res {bit_depth or '?'}-bit/{_khz(sample_rate)}"
        tier = 3
    elif lossless:
        label = f"Lossless {bit_depth or 16}-bit/{_khz(sample_rate)}"
        tier = 2
    elif bitrate:
        label = f"{(codec or 'lossy').upper()} {round(bitrate / 1000)} kbps"
        tier = 1 if bitrate >= 256_000 else 0
    else:
        label = (codec or "unknown").upper()
        tier = 0
    return {"lossless": bool(lossless), "hires": hires, "label": label, "tier": tier}


def _khz(rate) -> str:
    if not rate:
        return "?"
    value = rate / 1000
    return f"{value:g} kHz"


def infer_from_path(relative_parts: tuple) -> dict:
    """Artist/Album/NN Title.ext, the layout most collections already follow."""
    inferred = {}
    stem = relative_parts[-1].rsplit(".", 1)[0] if relative_parts else ""
    number = re.match(r"^\s*(\d{1,3})\s*[-._ ]\s*(.+)$", stem)
    if number:
        inferred["track"] = int(number.group(1))
        inferred["title"] = number.group(2).strip()
    if len(relative_parts) >= 2:
        inferred["album"] = relative_parts[-2]
    if len(relative_parts) >= 3:
        inferred["artist"] = relative_parts[-3]
    return inferred
