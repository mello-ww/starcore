"""Lyrics from the listener's own files: sidecar .lrc/.txt beside the track, or embedded tags.

Synced LRC (including the enhanced <mm:ss.xx> word timing karaoke files use) is parsed into
timed lines; two lines sharing a timestamp are read as an original and its translation, the
layout translated LRC files use. No lyric database is bundled and nothing is fetched.
"""

from pathlib import Path
import re

from . import audio

MAX_BYTES = 1024 * 1024
TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
WORD = re.compile(r"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>")
OFFSET = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)
METADATA = re.compile(r"^\[(ar|ti|al|au|by|length|re|ve|la|lang):([^\]]*)\]", re.IGNORECASE)
LANGUAGE_SUFFIX = re.compile(r"^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$", re.IGNORECASE)


def _ms(minutes, seconds, fraction) -> int:
    fraction = fraction or "0"
    scale = {1: 100, 2: 10, 3: 1}[len(fraction)]
    return (int(minutes) * 60 + int(seconds)) * 1000 + int(fraction) * scale


def parse(text: str) -> dict:
    offset = 0
    metadata = {}
    timed = []
    plain = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        match = OFFSET.match(line)
        if match:
            offset = int(match.group(1))
            continue
        match = METADATA.match(line)
        if match:
            metadata[match.group(1).lower()] = match.group(2).strip()
            continue
        stamps = []
        while True:
            match = TIMESTAMP.match(line)
            if not match:
                break
            stamps.append(_ms(*match.groups()))
            line = line[match.end():]
        if stamps:
            for stamp in stamps:
                timed.append((stamp, line.strip()))
        elif line:
            plain.append(line)

    if not timed:
        return {"synced": False, "lines": [], "plain": "\n".join(plain), "metadata": metadata, "karaoke": False}

    timed.sort(key=lambda item: item[0])
    lines = []
    for stamp, content in timed:
        words = _words(content)
        clean = WORD.sub("", content).strip()
        stamp = max(0, stamp - offset)  # a positive [offset] shows lyrics earlier
        if lines and lines[-1]["time"] == stamp and clean and lines[-1]["text"]:
            lines[-1]["translation"] = clean
            continue
        lines.append({"time": stamp, "text": clean, "words": words, "translation": None})
    karaoke = any(line["words"] for line in lines)
    return {"synced": True, "lines": lines, "plain": "\n".join(line["text"] for line in lines),
            "metadata": metadata, "karaoke": karaoke}


def _words(content: str) -> list:
    words = []
    matches = list(WORD.finditer(content))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        text = content[match.end():end]
        if text.strip():
            words.append({"time": _ms(*match.groups()), "text": text})
    return words


def _read(path: Path):
    try:
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = data.decode(encoding)
            if encoding == "utf-16" and not data[:2] in (b"\xff\xfe", b"\xfe\xff"):
                continue
            return text
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", "replace")


def sidecars(track_path: Path) -> list:
    """(language or None, path) for every lyric file beside the track: Song.lrc, Song.en.lrc, Song.txt."""
    found = []
    stem = track_path.stem
    try:
        entries = list(track_path.parent.iterdir())
    except OSError:
        return found
    for entry in sorted(entries):
        name = entry.name
        if not name.lower().endswith((".lrc", ".txt")) or not name.startswith(stem):
            continue
        middle = name[len(stem):-4]
        if middle == "":
            found.append((None, entry))
        elif middle.startswith(".") and LANGUAGE_SUFFIX.match(middle[1:]):
            found.append((middle[1:].lower(), entry))
    found.sort(key=lambda item: (item[0] is not None, not item[1].name.lower().endswith(".lrc")))
    return found


def lyrics(track_path: Path, language: str = None):
    candidates = sidecars(track_path)
    languages = sorted({lang for lang, _ in candidates if lang})
    chosen = None
    if language:
        chosen = next((path for lang, path in candidates if lang == language.lower()), None)
    if chosen is None and candidates:
        chosen = candidates[0][1]
    if chosen is not None:
        text = _read(chosen)
        if text and text.strip():
            result = parse(text)
            lang = next((lang for lang, path in candidates if path == chosen), None)
            return {**result, "source": "sidecar", "format": chosen.suffix.lower().lstrip("."),
                    "language": lang or result["metadata"].get("la") or result["metadata"].get("lang"),
                    "languages": languages}

    try:
        embedded = audio.probe(track_path).get("lyrics")
    except Exception:
        embedded = None
    if embedded:
        return {**parse(embedded), "source": "embedded", "format": "tag", "language": None, "languages": languages}
    return None
