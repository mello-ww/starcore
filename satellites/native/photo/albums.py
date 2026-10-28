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

# a fixed, well-known id (never one of the random hex ids create() hands out)
# so every client can toggle a photo's favorite status without first looking
# an id up - see ensure_favorites()/is_protected() below
FAVORITES_ID = "favorites"
FAVORITES_NAME = "Favorites"

# a physical album's id always carries this prefix, so a caller can tell one
# apart from a virtual/favorites album id (a bare hex token) without needing
# to ask which store it came from - see physical_albums() and api.py's
# routing between _albums_get/_albums_post and their _physical_* counterparts
PHYSICAL_ID_PREFIX = "physical:"
UNSORTED_PHYSICAL_ID = f"{PHYSICAL_ID_PREFIX}unsorted"

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
        # created here, not lazily on first read, so every route that
        # addresses "favorites" directly (add_photo/remove_photo/get, not
        # just the top-level listing) can rely on it already existing -
        # see ensure_favorites() below
        self.ensure_favorites()

    # ---------- reading ----------

    def all(self) -> list:
        """Every virtual album, Favorites included - sorted with Favorites
        always first (it isn't a photo the user named or ordered, so
        alphabetical sorting would place it arbitrarily among their own
        albums), then the rest by name."""
        return sorted(self._albums.values(), key=lambda album: (album["id"] != FAVORITES_ID, album["name"].casefold()))

    def get(self, album_id):
        return self._albums.get(album_id)

    def ensure_favorites(self) -> dict:
        """Creates the Favorites album on first use - a normal virtual album
        in every way (same photo_ids list, same add_photo/remove_photo) except
        for its fixed id and being protected from rename/delete (see
        rename()/delete() below)."""
        existing = self._albums.get(FAVORITES_ID)
        if existing is not None:
            return existing

        now = _now()
        album = {
            "id": FAVORITES_ID, "name": FAVORITES_NAME, "kind": "favorites",
            "created_at": now, "updated_at": now, "photo_ids": [],
        }
        self._albums[FAVORITES_ID] = album
        self._save()
        return album

    # ---------- writing ----------

    def create(self, name) -> dict:
        name = _validate_name(name)
        now = _now()
        album = {
            "id": _new_id(self._albums),
            "name": name,
            "kind": "virtual",
            "created_at": now,
            "updated_at": now,
            "photo_ids": [],
        }
        self._albums[album["id"]] = album
        self._save()
        return album

    def rename(self, album_id: str, name) -> dict:
        if album_id == FAVORITES_ID:
            raise AlbumError("Favorites can't be renamed")

        album = self._require(album_id)
        album["name"] = _validate_name(name)
        album["updated_at"] = _now()
        self._save()
        return album

    def delete(self, album_id: str) -> None:
        if album_id == FAVORITES_ID:
            raise AlbumError("Favorites can't be deleted")

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
            for album_id, album in loaded.items():
                # every album created before the physical/virtual/favorites
                # distinction existed is, by definition, a plain virtual one -
                # except the fixed Favorites id, which ensure_favorites()
                # itself always sets "kind" on when it first creates it
                album.setdefault("kind", "favorites" if album_id == FAVORITES_ID else "virtual")
            self._albums = loaded

    def _save(self):
        self.root.mkdir(parents=True, exist_ok=True)
        partial = self.index_path.with_suffix(".part")
        partial.write_text(json.dumps({"version": INDEX_VERSION, "albums": self._albums}, indent=2), encoding="utf-8")
        os.replace(partial, self.index_path)


def physical_albums(satellite, photo_library) -> list:
    """Physical albums: one per configured source_paths mapping (see
    configuration.py) - created the moment that mapping is saved, even before
    any photo has landed in it, per "adding a physical source path creates
    its physical album". Plus an "Unsorted" one, but only for a photo whose
    physical_path is a real (non-empty) value that no longer matches any
    configured mapping - the mapping that resolved it was since edited or
    removed (see configuration.resolve_physical_path()'s note on
    sync_default_path, which itself always resolves to *some* string, never
    to nothing at all).

    A photo with no physical_path *at all* (None) is a different case
    entirely: a desktop directory import (scan()/import_directory()), or one
    from the standalone local-network listener, which never resolves a
    physical album to begin with (see sync.accept_authenticated_upload()'s
    own docstring) - not "phone content that needs sorting". Those photos
    simply have no physical album, exactly like a photo imported before this
    concept existed, and are never swept into "Unsorted" - so a library with
    no source_paths configured and nothing synced yet still reports no
    physical albums at all.

    Unlike a virtual album, membership here is never stored anywhere: it's
    computed fresh from each photo's own `physical_path` field, because the
    path itself is the source of truth (see library.add_file()'s own
    docstring on `physical_path`) - there is nothing here for
    prune_missing() to ever need to do.
    """
    from .configuration import DEFAULTS

    mappings = satellite.config.get("source_paths", DEFAULTS["source_paths"])
    photos = photo_library.all()
    by_path = {}
    for photo in photos:
        by_path.setdefault(photo.get("physical_path"), []).append(photo)

    configured_paths = {entry["server_path"] for entry in mappings}
    albums = []
    for entry in mappings:
        members = by_path.get(entry["server_path"], [])
        albums.append(_physical_summary(f"{PHYSICAL_ID_PREFIX}{entry['id']}", entry["name"], entry["server_path"], members))

    unsorted_members = [
        photo for path, group in by_path.items() for photo in group
        if path is not None and path not in configured_paths
    ]
    if unsorted_members:
        albums.append(_physical_summary(UNSORTED_PHYSICAL_ID, "Unsorted", None, unsorted_members))

    return albums


def _physical_summary(album_id: str, name: str, server_path, members: list) -> dict:
    return {
        "id": album_id,
        "name": name,
        "kind": "physical",
        "server_path": server_path,
        "photo_count": len(members),
        "cover_photo_id": members[0]["id"] if members else None,
    }


def physical_album_detail(satellite, photo_library, album_id: str) -> dict:
    """The one physical album named by `album_id` (see physical_albums()
    above), with its full photo list resolved - the physical-album
    equivalent of api.py's _albums_get single-album branch."""
    for album in physical_albums(satellite, photo_library):
        if album["id"] != album_id:
            continue

        if album_id == UNSORTED_PHYSICAL_ID:
            configured_paths = {entry["server_path"] for entry in satellite.config.get("source_paths", [])}
            members = [
                photo for photo in photo_library.all()
                if photo.get("physical_path") is not None and photo.get("physical_path") not in configured_paths
            ]
        else:
            members = [photo for photo in photo_library.all() if photo.get("physical_path") == album["server_path"]]

        return {**album, "photos": members}

    raise AlbumNotFound(f"unknown physical album '{album_id}'")


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
