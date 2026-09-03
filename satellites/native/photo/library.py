"""The managed photo library: storage layout, metadata index and import."""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import shutil

from . import images

SATELLITE_NAME = "Photo"
INDEX_VERSION = 1
ID_LENGTH = 16
READ_SIZE = 1024 * 1024

_libraries = {}


class PhotoImportError(Exception):
    """Raised when a caller asks for something the library cannot import."""


def library(satellite):
    """The library of a satellite, kept per storage root so tests stay isolated."""
    root = storage_root(satellite)

    if root not in _libraries:
        _libraries[root] = PhotoLibrary(root, satellite.config.get("thumbnail_size", 480))

    return _libraries[root]


def library_for(engine):
    satellite = engine.registry.get(SATELLITE_NAME)
    return library(satellite) if satellite else None


def storage_root(satellite) -> Path:
    configured = Path(str(satellite.config.get("storage", "data"))).expanduser()
    root = configured if configured.is_absolute() else satellite.path / configured
    return root.resolve()


class PhotoLibrary:
    def __init__(self, root: Path, thumbnail_size: int = 480):
        self.root = Path(root).resolve()
        self.photos_dir = self.root / "photos"
        self.thumbnails_dir = self.root / "thumbnails"
        self.index_path = self.root / "library.json"
        self.thumbnail_size = int(thumbnail_size)
        self._photos = {}
        self._load()

    # ---------- library ----------

    @property
    def count(self) -> int:
        return len(self._photos)

    @property
    def size(self) -> int:
        return sum(photo["size"] for photo in self._photos.values())

    def summary(self) -> dict:
        return {
            "photos": self.count,
            "size_bytes": self.size,
            "storage": str(self.root),
            "formats": sorted(set(images.EXTENSIONS)),
            "thumbnails": images.thumbnails_available(),
        }

    def all(self) -> list:
        return sorted(self._photos.values(), key=_taken_at, reverse=True)

    def get(self, photo_id):
        return self._photos.get(photo_id)

    def original_path(self, photo: dict) -> Path:
        path = (self.root / photo["path"]).resolve()
        if not path.is_relative_to(self.root):
            raise PhotoImportError("the photo is stored outside the library")

        return path

    def thumbnail_path(self, photo: dict) -> Path:
        """A cached thumbnail, rendered on first use, falling back to the original."""
        original = self.original_path(photo)
        thumbnail = self.thumbnails_dir / photo["id"][:2] / f"{photo['id']}.jpg"

        if thumbnail.is_file():
            return thumbnail

        # rendered aside and moved into place, so a request arriving while another
        # is still writing never reads half a file
        thumbnail.parent.mkdir(parents=True, exist_ok=True)
        partial = thumbnail.with_name(f".{photo['id']}.{os.getpid()}.part")

        if images.thumbnail(original, partial, self.thumbnail_size):
            os.replace(partial, thumbnail)
            return thumbnail

        partial.unlink(missing_ok=True)
        return original

    # ---------- import ----------

    def add_file(self, source, filename: str = None, save: bool = True):
        """Takes a single file into the library.

        Returns the new record, or None when that exact image is already stored.
        Every import path goes through here, so a future synchronization endpoint
        can hand over an uploaded file without touching the storage layout.
        """
        source = Path(source)
        photo_id = _digest(source)[:ID_LENGTH]

        if photo_id in self._photos:
            return None

        information = images.probe(source)
        exif = images.exif_metadata(source)
        relative = Path("photos") / photo_id[:2] / f"{photo_id}{images.EXTENSIONS[information['format']]}"
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)

        # copied aside first, so an interrupted import cannot leave a half written
        # file under a name the index would consider complete
        partial = destination.with_name(f".{photo_id}.part")
        shutil.copy2(source, partial)
        os.replace(partial, destination)

        photo = {
            "id": photo_id,
            "filename": filename or source.name,
            "path": relative.as_posix(),
            "size": destination.stat().st_size,
            "width": information["width"],
            "height": information["height"],
            "format": information["format"],
            "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "captured_at": exif["captured_at"],
            "metadata": {
                "megapixels": images.megapixels(information["width"], information["height"]),
                **{key: value for key, value in exif.items() if key != "captured_at"},
            },
        }

        self._photos[photo_id] = photo
        if save:
            self._save()

        return photo

    def scan(self, source) -> dict:
        """Reports what importing a directory would do, without writing anything."""
        source = self._source(source)
        found = duplicates = 0
        seen = set()

        for path in self._candidates(source):
            found += 1
            try:
                photo_id = _digest(path)[:ID_LENGTH]
            except OSError:
                continue

            if photo_id in self._photos or photo_id in seen:
                duplicates += 1
            else:
                seen.add(photo_id)

        return {"source": str(source), "found": found, "new": len(seen), "duplicates": duplicates}

    def import_directory(self, source) -> dict:
        source = self._source(source)
        imported = []
        failed = []
        found = duplicates = 0

        for path in self._candidates(source):
            found += 1
            try:
                photo = self.add_file(path, save=False)
            except (images.UnsupportedImage, OSError, ValueError) as error:
                failed.append({"file": path.name, "reason": str(error)})
                continue

            if photo is None:
                duplicates += 1
            else:
                imported.append(photo)

        if imported:
            self._save()

        return {
            "source": str(source),
            "found": found,
            "imported": len(imported),
            "duplicates": duplicates,
            "failed": failed,
            "photos": imported,
        }

    def _source(self, source) -> Path:
        if not str(source).strip():
            raise PhotoImportError("no source directory was given")

        path = Path(str(source).strip()).expanduser()
        try:
            path = path.resolve()
        except OSError as error:
            raise PhotoImportError(f"'{source}' cannot be read ({error})")

        if not path.exists():
            raise PhotoImportError(f"'{path}' does not exist")
        if not path.is_dir():
            raise PhotoImportError(f"'{path}' is not a directory")
        if path == self.root or self.root in path.parents:
            raise PhotoImportError("the photo library cannot import itself")

        return path

    def _candidates(self, source: Path):
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in images.FORMATS:
                continue
            if path == self.root or self.root in path.parents:
                continue

            yield path

    # ---------- index ----------

    def _load(self):
        if not self.index_path.is_file():
            return

        try:
            index = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"[WARNING]: photo index {self.index_path} could not be read ({error}). Starting empty.")
            return

        photos = index.get("photos")
        if isinstance(photos, dict):
            for photo in photos.values():
                _backfill_metadata(photo)
            self._photos = photos

    def _save(self):
        self.root.mkdir(parents=True, exist_ok=True)
        partial = self.index_path.with_suffix(".part")
        partial.write_text(json.dumps({"version": INDEX_VERSION, "photos": self._photos}, indent=2), encoding="utf-8")
        os.replace(partial, self.index_path)


def _backfill_metadata(photo: dict) -> None:
    """Fills in the metadata shape for a photo imported before this existed.

    In memory only - existing library.json entries are never rewritten just for
    being read, so every consumer (API, CLI, UI) can rely on "metadata" always
    being a dict with the full set of known keys, present or not, without a
    migration step and without touching a file that otherwise wouldn't change.
    """
    if not isinstance(photo.get("metadata"), dict):
        photo["metadata"] = {
            "megapixels": images.megapixels(photo.get("width"), photo.get("height")),
            **dict.fromkeys(images.METADATA_FIELDS),
        }


def readable_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def _digest(path: Path) -> str:
    digest = hashlib.sha256()

    with open(path, "rb") as file:
        while chunk := file.read(READ_SIZE):
            digest.update(chunk)

    return digest.hexdigest()


def _taken_at(photo: dict) -> str:
    return photo.get("captured_at") or photo.get("imported_at") or ""
