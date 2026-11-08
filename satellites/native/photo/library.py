"""The managed photo library: storage layout, metadata index and import."""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import secrets
import shutil
import threading
import time

from . import images, videos

SATELLITE_NAME = "Photo"
INDEX_VERSION = 1
ID_LENGTH = 16
READ_SIZE = 1024 * 1024
THUMBNAIL_RETRY_SECONDS = 300  # before a video whose frame failed is tried again

# the extensions a directory scan bothers opening at all - a fast filename
# prefilter only. What a file actually *is* is always decided by content, in
# add_file() below (see its own docstring), never by this set alone.
_CANDIDATE_SUFFIXES = set(images.FORMATS) | set(videos.FORMATS)

_libraries = {}
_creating = threading.RLock()
_writing = threading.Lock()


class PhotoImportError(Exception):
    """Raised when a caller asks for something the library cannot import."""


class PhotoNotFound(Exception):
    """Raised when a caller names a photo id the library doesn't have - or,
    for restore/erase, one that isn't currently in the recycle bin."""


def library(satellite):
    """The library of a satellite, kept per storage root so tests stay isolated."""
    root = storage_root(satellite)

    # requests arrive on several threads at once: two must never each build their own copy
    with _creating:
        if root not in _libraries:
            _libraries[root] = PhotoLibrary(root, satellite.config.get("thumbnail_size", 480))

    return _libraries[root]


def library_for(engine):
    satellite = engine.registry.get(SATELLITE_NAME)
    return library(satellite) if satellite else None


def write_index(path: Path, data: dict) -> None:
    """Writes a JSON index aside and moves it into place. Each write gets its own staging
    name and writes are serialized: on Windows, two requests renaming the same staging
    file at once fail with "file in use" (WinError 32)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _writing:
        partial = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
        try:
            partial.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.replace(partial, path)
        finally:
            partial.unlink(missing_ok=True)


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
        # held for every change of a photo's state (bin, restore, erase, purge, a move out of the
        # library), so a photo can't be binned between the last check and its removal
        self._changing = threading.RLock()
        # videos ffmpeg couldn't render a frame for, by content-addressed id,
        # with the binary tried and when - so the grid doesn't re-run it on
        # every load, yet retries once ffmpeg is installed or a while has passed
        self._thumbnail_failures = {}
        self._load()

    # ---------- library ----------

    @property
    def count(self) -> int:
        """Active photos only - one sitting in the recycle bin is logically
        gone, awaiting either restore or the retention period running out."""
        return sum(1 for photo in self._photos.values() if not photo.get("trashed_at"))

    @property
    def size(self) -> int:
        return sum(photo["size"] for photo in self._photos.values() if not photo.get("trashed_at"))

    def summary(self) -> dict:
        active = [photo for photo in self._photos.values() if not photo.get("trashed_at")]
        return {
            "photos": len(active),
            "images": sum(1 for photo in active if photo.get("media_type", "photo") == "photo"),
            "videos": sum(1 for photo in active if photo.get("media_type") == "video"),
            "size_bytes": self.size,
            "storage": str(self.root),
            "formats": sorted(set(images.EXTENSIONS) | set(videos.EXTENSIONS)),
            "thumbnails": images.thumbnails_available(),
            "video_thumbnails": videos.thumbnails_available(),
        }

    def all(self) -> list:
        """Every active photo or video, newest first - one in the recycle bin
        is excluded, exactly as if it had actually been deleted (see trash())."""
        return sorted((photo for photo in self._photos.values() if not photo.get("trashed_at")),
                      key=_taken_at, reverse=True)

    def all_ids(self) -> set:
        """Every id the library still physically holds, active or trashed -
        what album membership is pruned against (AlbumStore.prune_missing),
        so moving a photo to the recycle bin never silently drops it from an
        album; only actually erasing it does."""
        return set(self._photos)

    def get(self, photo_id):
        """A photo, or None if it doesn't exist - or is currently in the
        recycle bin, which behaves as "doesn't exist" everywhere except the
        dedicated recycle-bin endpoints (see get_any() and the trash routes)."""
        photo = self._photos.get(photo_id)
        return photo if photo is not None and not photo.get("trashed_at") else None

    def get_any(self, photo_id):
        """A photo whether active or trashed - only for the recycle-bin
        routes themselves (previewing, restoring, permanently erasing)."""
        return self._photos.get(photo_id)

    def original_path(self, photo: dict) -> Path:
        path = (self.root / photo["path"]).resolve()
        if not path.is_relative_to(self.root):
            raise PhotoImportError("the photo is stored outside the library")

        return path

    def _thumbnail_file(self, photo: dict) -> Path:
        return self.thumbnails_dir / photo["id"][:2] / f"{photo['id']}.jpg"

    def content_type(self, photo: dict) -> str:
        """The original file's own content type - images.py/videos.py each
        own their half of the format-to-content-type mapping, so this is the
        one place a caller (the API's file-serving routes) needs to know
        about media_type at all."""
        if photo.get("media_type") == "video":
            return videos.CONTENT_TYPES[photo["format"]]
        return images.CONTENT_TYPES[photo["format"]]

    def thumbnail_path(self, photo: dict) -> Path:
        """A cached thumbnail, rendered on first use. A photo falls back to
        serving the original when no thumbnail could be rendered (no Pillow);
        a video has no such fallback (nothing can display a raw video file as
        a thumbnail image) and instead reports having none - see api.py's
        `thumbnails` route."""
        original = self.original_path(photo)
        thumbnail = self._thumbnail_file(photo)

        if thumbnail.is_file():
            return thumbnail

        # rendered aside and moved into place, so a request arriving while another
        # is still writing never reads half a file
        thumbnail.parent.mkdir(parents=True, exist_ok=True)
        partial = thumbnail.with_name(f".{photo['id']}.{secrets.token_hex(4)}.part")

        is_video = photo.get("media_type") == "video"
        if is_video and self._thumbnail_failed_recently(photo["id"]):
            return None
        rendered = (
            videos.thumbnail(original, partial, self.thumbnail_size, duration=photo.get("duration"))
            if is_video else images.thumbnail(original, partial, self.thumbnail_size)
        )

        if rendered:
            os.replace(partial, thumbnail)
            return thumbnail

        partial.unlink(missing_ok=True)
        if is_video:
            self._thumbnail_failures[photo["id"]] = (videos._load_ffmpeg(), time.monotonic())
            return None
        return original

    def _thumbnail_failed_recently(self, photo_id) -> bool:
        failure = self._thumbnail_failures.get(photo_id)
        if failure is None:
            return False
        binary, at = failure
        return binary == videos._load_ffmpeg() and time.monotonic() - at < THUMBNAIL_RETRY_SECONDS

    # ---------- import ----------

    def add_file(self, source, filename: str = None, save: bool = True, physical_path: str = None, private=None):
        """Takes a single file into the library.

        Returns the new record, or None when that exact image is already stored.
        Every import path goes through here, so a future synchronization endpoint
        can hand over an uploaded file without touching the storage layout.

        `physical_path` is metadata only - it never changes where the file is
        actually stored (still the content-addressed photos/<id> layout below).
        It is the resolved server-side "physical album" path (see
        configuration.py's `source_paths`) for a phone-synced upload whose
        phone folder matched a configured mapping, or the satellite's
        `sync_default_path` when it didn't - see sync.accept_authenticated_upload().
        A directory scan/import (scan()/import_directory()) never sets this;
        those photos simply have no physical album, exactly like a photo
        imported before this concept existed.

        `private` (see private_media.py) refuses media that was moved into the
        Locked Folder: it is answered exactly like a duplicate, so a phone
        that still has the photo stops re-sending it, and nothing tells the
        caller where it went.
        """
        source = Path(source)
        full_digest = _digest(source)
        photo_id = full_digest[:ID_LENGTH]

        if photo_id in self._photos:
            return None
        if private is not None and private.is_sealed(full_digest):
            return None

        # recognized by content, never by filename - the same reason
        # images.probe() already sniffs magic bytes instead of trusting an
        # extension: a phone sync upload arrives under a generic temp name
        # (see sync.py's SyncService.accept()), extension-less and all
        try:
            information = images.probe(source)
            media_type = "photo"
        except images.UnsupportedImage as image_error:
            try:
                information = videos.probe(source)
                media_type = "video"
            except videos.UnsupportedVideo:
                raise image_error from None

        if media_type == "video":
            # a video carries no EXIF-style metadata this library reads yet
            # (no camera/GPS tags parsed from MP4 boxes) - every field here
            # simply stays None, same as a photo none of these applied to
            exif = dict.fromkeys(images.METADATA_FIELDS)
            extension = videos.EXTENSIONS[information["format"]]
        else:
            exif = images.exif_metadata(source)
            extension = images.EXTENSIONS[information["format"]]

        relative = Path("photos") / photo_id[:2] / f"{photo_id}{extension}"
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)

        # copied aside first, so an interrupted import cannot leave a half written
        # file under a name the index would consider complete
        partial = destination.with_name(f".{photo_id}.{secrets.token_hex(4)}.part")
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
            "media_type": media_type,
            "duration": information.get("duration") if media_type == "video" else None,
            "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "captured_at": exif["captured_at"],
            "metadata": {
                "megapixels": images.megapixels(information["width"], information["height"]),
                **{key: value for key, value in exif.items() if key != "captured_at"},
            },
            "trashed_at": None,
            "physical_path": physical_path,
        }

        self._photos[photo_id] = photo
        if save:
            self._save()

        return photo

    def scan(self, source, private=None) -> dict:
        """Reports what importing a directory would do, without writing anything.

        Anything inside the Locked Folder is skipped without being counted
        (see private_media.py), and a source inside it is refused outright."""
        source = self._source(source, private)
        found = duplicates = 0
        seen = set()

        for path in self._candidates(source, private):
            found += 1
            try:
                full_digest = _digest(path)
            except OSError:
                continue
            photo_id = full_digest[:ID_LENGTH]

            if photo_id in self._photos or photo_id in seen or (private and private.is_sealed(full_digest)):
                duplicates += 1
            else:
                seen.add(photo_id)

        return {"source": str(source), "found": found, "new": len(seen), "duplicates": duplicates}

    def import_directory(self, source, private=None) -> dict:
        source = self._source(source, private)
        imported = []
        failed = []
        found = duplicates = 0

        for path in self._candidates(source, private):
            found += 1
            try:
                photo = self.add_file(path, save=False, private=private)
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

    # ---------- recycle bin ----------

    def trashed(self, retention_days: int) -> list:
        """Everything currently in the recycle bin, newest-trashed first.
        Purges anything past its retention period first, so a caller never
        sees - or can restore - a photo that has already been erased."""
        self._purge_expired(retention_days)
        return sorted(
            (photo for photo in self._photos.values() if photo.get("trashed_at")),
            key=lambda photo: photo["trashed_at"], reverse=True,
        )

    def trash(self, photo_id: str) -> dict:
        """Soft-deletes an active photo: it disappears from the library (all(),
        get(), albums) but its file is untouched until it is either restored
        or its retention period runs out - see docs/photo.md."""
        with self._changing:
            photo = self._photos.get(photo_id)
            if photo is None or photo.get("trashed_at"):
                raise PhotoNotFound(f"unknown photo '{photo_id}'")

            photo["trashed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._save()
            return photo

    def restore(self, photo_id: str) -> dict:
        with self._changing:
            photo = self._photos.get(photo_id)
            if photo is None or not photo.get("trashed_at"):
                raise PhotoNotFound(f"'{photo_id}' is not in the recycle bin")

            photo["trashed_at"] = None
            self._save()
            return photo

    def erase(self, photo_id: str) -> None:
        """Permanently removes a photo that is already in the recycle bin -
        its stored original and thumbnail are deleted, and it leaves the
        index entirely. Only ever reachable from the recycle bin, never
        directly from an active photo, so a permanent delete always has to
        go through trash() first."""
        with self._changing:
            photo = self._photos.get(photo_id)
            if photo is None or not photo.get("trashed_at"):
                raise PhotoNotFound(f"'{photo_id}' is not in the recycle bin")

            self._delete_stored_files(photo)
            del self._photos[photo_id]
            self._save()

    def _purge_expired(self, retention_days: int) -> None:
        cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
        with self._changing:
            expired = [
                photo_id for photo_id, photo in self._photos.items()
                if photo.get("trashed_at") and _iso_timestamp(photo["trashed_at"]) <= cutoff
            ]

            for photo_id in expired:
                self._delete_stored_files(self._photos[photo_id])
                del self._photos[photo_id]

            if expired:
                self._save()

    def _delete_stored_files(self, photo: dict) -> None:
        self.original_path(photo).unlink(missing_ok=True)
        self._thumbnail_file(photo).unlink(missing_ok=True)

    def remove_moved(self, photo_id: str) -> None:
        """Takes a photo out of the library for good because a verified copy
        now lives elsewhere (the Locked Folder) - unlike erase(), without
        going through the recycle bin, which would leave a second, visible
        copy behind. The index is saved first; if deleting the stored file
        then fails, it is merely an orphan no listing can reach.

        Checked again here, under the lock every state change takes: a photo binned, erased or
        moved since the caller looked is refused (PhotoNotFound), so the caller undoes its copy."""
        with self._changing:
            photo = self._photos.get(photo_id)
            if photo is None or photo.get("trashed_at"):
                raise PhotoNotFound(f"'{photo_id}' is no longer in the library")

            del self._photos[photo_id]
            try:
                self._save()
            except Exception:
                self._photos[photo_id] = photo
                raise

        try:
            self._delete_stored_files(photo)
        except OSError as error:
            print(f"[WARNING]: a moved photo's library copy could not be deleted ({error.strerror}).")

    def _source(self, source, private=None) -> Path:
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
        if private is not None and private.is_private(path):
            raise PhotoImportError("the Locked Folder cannot be imported into Photos - "
                                   "move photos out of it from the Locked Folder instead")

        return path

    def _candidates(self, source: Path, private=None):
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in _CANDIDATE_SUFFIXES:
                continue
            if path == self.root or self.root in path.parents:
                continue
            # checked on the resolved path, so a link elsewhere in the source
            # that points into the vault is skipped too
            if private is not None and private.is_private(path):
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
                photo.setdefault("trashed_at", None)
                # every photo imported before video support existed is, by
                # definition, a photo - never re-probed just to learn that
                photo.setdefault("media_type", "photo")
                photo.setdefault("duration", None)
                # every photo imported before physical albums existed simply
                # has no physical album, exactly like it has no media_type
                # override above - never re-resolved just for being read
                photo.setdefault("physical_path", None)
            self._photos = photos

    def _save(self):
        write_index(self.index_path, {"version": INDEX_VERSION, "photos": self._photos})


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


def _iso_timestamp(value: str) -> float:
    return datetime.fromisoformat(value).timestamp()
