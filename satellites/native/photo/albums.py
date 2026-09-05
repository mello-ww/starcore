"""Custom photo albums: user-created groupings of photos, kept in their own
index alongside the library's own library.json.

Albums are metadata only - they hold photo ids, never copies of the photos
themselves - so deleting an album, or removing a photo from one, never
touches anything under photos/ or thumbnails/. Ids are the same stable,
content-addressed identifiers the library already assigns (see library.py),
never filenames, so an album keeps pointing at the right photo even if its
filename metadata changes. An id an album still lists that the library no
longer recognises (nothing currently deletes a photo from the library
itself, but a future release might) is simply skipped wherever an album's
photos are resolved, and pruned from the album the next time it is read
through the API - the file on disk is never rewritten just for being read,
same as library.py's own tolerant-loading convention.
"""

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import secrets

NAME_MAX_LENGTH = 120
ALBUM_ID_BYTES = 8  # -> 16 hex characters, matching the library's own id length
INDEX_VERSION = 1

_stores = {}


class AlbumError(Exception):
    """Raised when a caller's request is invalid - a missing/too-long name, an
    unknown photo id, and so on. The API layer turns this into a 400."""


class AlbumNotFound(AlbumError):
    """Raised when an album id does not exist. A subclass of AlbumError so
    code that only cares "something is wrong with this request" can catch
    just AlbumError, while the API layer catches this one specifically to
    answer with a 404 instead of a 400."""


def albums(satellite):
    """The album store of a satellite, kept per storage root so tests stay
    isolated - mirrors library()'s own per-root caching in library.py."""
    from .library import storage_root
    root = storage_root(satellite)

    if root not in _stores:
        _stores[root] = AlbumStore(root)

    return _stores[root]


class AlbumStore:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.index_path = self.root / "albums.json"
        self._albums = {}
        self._load()

    # ---------- reading ----------

    def all(self) -> list:
        return sorted(self._albums.values(), key=lambda album: album["name"].casefold())

    def get(self, album_id):
        return self._albums.get(album_id)

    # ---------- writing ----------

    def create(self, name) -> dict:
        name = _validate_name(name)
        now = _now()
        album = {
            "id": _new_id(self._albums),
            "name": name,
            "created_at": now,
            "updated_at": now,
            "photo_ids": [],
        }
        self._albums[album["id"]] = album
        self._save()
        return album

    def rename(self, album_id: str, name) -> dict:
        album = self._require(album_id)
        album["name"] = _validate_name(name)
        album["updated_at"] = _now()
        self._save()
        return album

    def delete(self, album_id: str) -> None:
        self._require(album_id)
        del self._albums[album_id]
        self._save()

    def add_photo(self, album_id: str, photo_id: str) -> dict:
        album = self._require(album_id)
        if photo_id not in album["photo_ids"]:
            album["photo_ids"].append(photo_id)
            album["updated_at"] = _now()
            self._save()
        return album

    def remove_photo(self, album_id: str, photo_id: str) -> dict:
        album = self._require(album_id)
        if photo_id in album["photo_ids"]:
            album["photo_ids"].remove(photo_id)
            album["updated_at"] = _now()
            self._save()
        return album

    def prune_missing(self, album_id: str, known_ids) -> dict:
        """Drops any photo id an album still lists that the library no longer
        has, saving only when that actually changes anything."""
        album = self._require(album_id)
        kept = [photo_id for photo_id in album["photo_ids"] if photo_id in known_ids]
        if len(kept) != len(album["photo_ids"]):
            album["photo_ids"] = kept
            album["updated_at"] = _now()
            self._save()
        return album

    def _require(self, album_id: str) -> dict:
        album = self._albums.get(album_id)
        if album is None:
            raise AlbumNotFound(f"unknown album '{album_id}'")
        return album

    # ---------- index ----------

    def _load(self):
        if not self.index_path.is_file():
            return

        try:
            index = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"[WARNING]: album index {self.index_path} could not be read ({error}). Starting empty.")
            return

        loaded = index.get("albums")
        if isinstance(loaded, dict):
            self._albums = loaded

    def _save(self):
        self.root.mkdir(parents=True, exist_ok=True)
        partial = self.index_path.with_suffix(".part")
        partial.write_text(json.dumps({"version": INDEX_VERSION, "albums": self._albums}, indent=2), encoding="utf-8")
        os.replace(partial, self.index_path)


def _validate_name(name) -> str:
    text = str(name).strip() if name is not None else ""
    if not text:
        raise AlbumError("an album needs a name")
    if len(text) > NAME_MAX_LENGTH:
        raise AlbumError(f"an album name can be at most {NAME_MAX_LENGTH} characters")
    return text


def _new_id(existing: dict) -> str:
    while True:
        candidate = secrets.token_hex(ALBUM_ID_BYTES)
        if candidate not in existing:
            return candidate


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
