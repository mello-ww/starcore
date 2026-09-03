"""The music library: an index over files that stay where the listener put them.

Photos are copied into StarCore because a phone throws them at it; a music
collection is already organised on disk and can be large, so this satellite
indexes in place and never moves or rewrites a file.
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os

from . import audio

SATELLITE_NAME = "Music"
INDEX_VERSION = 1
ID_LENGTH = 16
SAMPLE = 256 * 1024

UNKNOWN_ALBUM = "Unknown album"
UNKNOWN_ARTIST = "Unknown artist"

_libraries = {}


class MusicScanError(Exception):
    """Raised when a caller asks for a directory the library cannot scan."""


def library(satellite):
    root = storage_root(satellite)

    if root not in _libraries:
        _libraries[root] = MusicLibrary(root, satellite.config.get("library", "~/Music"))

    return _libraries[root]


def library_for(engine):
    satellite = engine.registry.get(SATELLITE_NAME)
    return library(satellite) if satellite else None


def storage_root(satellite) -> Path:
    configured = Path(str(satellite.config.get("storage", "data"))).expanduser()
    root = configured if configured.is_absolute() else satellite.path / configured
    return root.resolve()


class MusicLibrary:
    def __init__(self, root: Path, source: str = "~/Music"):
        self.root = Path(root).resolve()
        self.artwork_dir = self.root / "artwork"
        self.index_path = self.root / "library.json"
        self.source = str(source)
        self._tracks = {}
        self._last_scan = None
        self._load()

    # ---------- library ----------

    @property
    def count(self) -> int:
        return len(self._tracks)

    @property
    def size(self) -> int:
        return sum(track["size"] for track in self._tracks.values())

    @property
    def duration(self) -> float:
        return round(sum(track["duration"] or 0 for track in self._tracks.values()), 1)

    def summary(self) -> dict:
        return {
            "tracks": self.count,
            "albums": len(self.albums()),
            "artists": len(self.artists()),
            "size_bytes": self.size,
            "duration": self.duration,
            "last_scan": self._last_scan,
            "source": str(self._expand(self.source)),
            "storage": str(self.root),
            "formats": sorted(set(audio.CONTENT_TYPES)),
        }

    def tracks(self) -> list:
        return sorted(self._tracks.values(), key=_track_order)

    def track(self, track_id):
        return self._tracks.get(track_id)

    def albums(self) -> list:
        grouped = {}

        for track in self._tracks.values():
            album = _album_of(track)
            entry = grouped.setdefault(album["id"], {**album, "tracks": 0, "duration": 0.0, "artwork": None})
            entry["tracks"] += 1
            entry["duration"] = round(entry["duration"] + (track["duration"] or 0), 1)
            if entry["artwork"] is None and track["has_artwork"]:
                entry["artwork"] = track["id"]
            if entry["year"] is None:
                entry["year"] = track["year"]

        return sorted(grouped.values(), key=lambda album: (album["artist"].lower(), album["album"].lower()))

    def album(self, album_id):
        found = next((album for album in self.albums() if album["id"] == album_id), None)
        if found is None:
            return None

        tracks = [track for track in self._tracks.values() if _album_of(track)["id"] == album_id]
        return {**found, "tracks": sorted(tracks, key=_track_order)}

    def artists(self) -> list:
        grouped = {}

        for track in self._tracks.values():
            album = _album_of(track)
            entry = grouped.setdefault(album["artist"], {"name": album["artist"], "albums": set(), "tracks": 0})
            entry["albums"].add(album["id"])
            entry["tracks"] += 1

        return sorted(
            ({"name": entry["name"], "albums": len(entry["albums"]), "tracks": entry["tracks"]}
             for entry in grouped.values()),
            key=lambda artist: artist["name"].lower())

    def track_path(self, track: dict) -> Path:
        path = Path(track["path"])
        if not path.is_file():
            raise MusicScanError("the file is no longer on disk")

        return path

    def artwork_path(self, album: dict):
        """Cover art for an album, extracted from its first track that carries any."""
        if not album.get("artwork"):
            return None

        cached = next(self.artwork_dir.glob(f"{album['id']}.*"), None)
        if cached is not None:
            return cached

        track = self._tracks.get(album["artwork"])
        if track is None:
            return None

        extracted = audio.artwork(Path(track["path"]))
        if extracted is None:
            return None

        # written aside and moved into place, so a request arriving while another is
        # still writing never reads half a file
        data, content_type = extracted
        self.artwork_dir.mkdir(parents=True, exist_ok=True)
        target = self.artwork_dir / f"{album['id']}.{'png' if content_type.endswith('png') else 'jpg'}"
        partial = target.with_name(f".{album['id']}.{os.getpid()}.part")
        partial.write_bytes(data)
        os.replace(partial, target)
        return target

    # ---------- scanning ----------

    def scan(self, source=None) -> dict:
        """Indexes a directory in place. Safe to run repeatedly."""
        root = self._source(source)
        found = added = updated = duplicates = unchanged = 0
        failed = []
        by_path = {track["path"]: track for track in self._tracks.values()}

        for path in self._candidates(root):
            found += 1
            known = by_path.get(str(path))
            status = os.stat(path)

            if known and known["size"] == status.st_size and known["mtime"] == int(status.st_mtime):
                unchanged += 1
                continue

            try:
                track = self._read(path, status)
            except Exception as error:
                failed.append({"file": path.name, "reason": str(error)})
                continue

            existing = self._tracks.get(track["id"])
            if existing is not None and existing["path"] != track["path"] and Path(existing["path"]).is_file():
                duplicates += 1
                continue

            # editing a file changes its identity, so whatever this path held before
            # has to leave the index with it
            replaced = self._forget_path(track["path"], keep=track["id"])
            self._tracks[track["id"]] = track
            if existing is None and not replaced:
                added += 1
            else:
                updated += 1

        removed = self._prune()
        self._last_scan = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._save()

        return {
            "source": str(root),
            "found": found,
            "added": added,
            "updated": updated,
            "unchanged": unchanged,
            "duplicates": duplicates,
            "removed": removed,
            "failed": failed,
            "tracks": self.count,
        }

    def _read(self, path: Path, status) -> dict:
        tags = audio.probe(path)

        return {
            "id": _fingerprint(path, status.st_size),
            "path": str(path),
            "filename": path.name,
            "format": tags["format"],
            "size": status.st_size,
            "mtime": int(status.st_mtime),
            "title": tags["title"] or path.stem,
            "artist": tags["artist"],
            "album": tags["album"],
            "album_artist": tags["album_artist"],
            "track": tags["track"],
            "disc": tags["disc"],
            "year": tags["year"],
            "genre": tags["genre"],
            "duration": tags["duration"],
            "has_artwork": tags["has_artwork"],
            "indexed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    def _forget_path(self, path: str, keep: str) -> bool:
        stale = [track_id for track_id, track in self._tracks.items()
                 if track["path"] == path and track_id != keep]
        for track_id in stale:
            del self._tracks[track_id]

        return bool(stale)

    def _prune(self) -> int:
        missing = [track_id for track_id, track in self._tracks.items() if not Path(track["path"]).is_file()]
        for track_id in missing:
            del self._tracks[track_id]

        return len(missing)

    def _source(self, source=None) -> Path:
        candidate = str(source or self.source).strip()
        if not candidate:
            raise MusicScanError("no music directory is configured")

        path = self._expand(candidate)
        if not path.exists():
            raise MusicScanError(f"'{path}' does not exist")
        if not path.is_dir():
            raise MusicScanError(f"'{path}' is not a directory")

        return path

    def _expand(self, source: str) -> Path:
        try:
            return Path(source).expanduser().resolve()
        except OSError:
            return Path(source)

    def _candidates(self, root: Path):
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix.lower() in audio.FORMATS and self.root not in path.parents:
                yield path

    # ---------- index ----------

    def _load(self):
        if not self.index_path.is_file():
            return

        try:
            index = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"[WARNING]: music index {self.index_path} could not be read ({error}). Starting empty.")
            return

        if isinstance(index.get("tracks"), dict):
            self._tracks = index["tracks"]
            self._last_scan = index.get("last_scan")

    def _save(self):
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {"version": INDEX_VERSION, "last_scan": self._last_scan, "tracks": self._tracks}
        partial = self.index_path.with_suffix(".part")
        partial.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(partial, self.index_path)


def readable_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def readable_duration(seconds) -> str:
    total = int(seconds or 0)
    if total >= 3600:
        return f"{total // 3600}h {total % 3600 // 60}m"
    return f"{total // 60}:{total % 60:02d}"


def _fingerprint(path: Path, size: int) -> str:
    """Identity from the size and both ends of the file.

    Hashing whole albums of lossless audio on every scan would make the library
    unusable, and the first and last quarter-megabyte of two different recordings
    are never the same.
    """
    digest = hashlib.sha256(str(size).encode("ascii"))

    with open(path, "rb") as file:
        digest.update(file.read(SAMPLE))
        if size > SAMPLE * 2:
            file.seek(-SAMPLE, os.SEEK_END)
            digest.update(file.read(SAMPLE))

    return digest.hexdigest()[:ID_LENGTH]


def _album_of(track: dict) -> dict:
    artist = track["album_artist"] or track["artist"] or UNKNOWN_ARTIST
    album = track["album"] or UNKNOWN_ALBUM
    identity = hashlib.sha256(f"{artist}\x00{album}".lower().encode("utf-8")).hexdigest()[:ID_LENGTH]

    return {"id": identity, "album": album, "artist": artist, "year": track["year"]}


def _track_order(track: dict) -> tuple:
    album = _album_of(track)
    return (
        album["artist"].lower(),
        album["album"].lower(),
        track["disc"] or 0,
        track["track"] or 0,
        (track["title"] or "").lower(),
    )
