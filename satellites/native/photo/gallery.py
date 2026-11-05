"""The library shaped for Photo's ui.json (UI contract 1.2's media-grid).

UI documents have no expression language, so this is the one Photo-specific step between the
library and the shared gallery: it decides what a tile and the viewer show (the month a photo
belongs to, its dimensions and camera as text, whether it is a favourite) and nothing else. It
reads the same library, albums and recycle bin as every other route, through the same
functions, and never writes: every action in the document goes to the existing routes
(albums/favorites/photos, trash/<id>, ...), unchanged.

GET gallery                   every active photo and video, newest first, grouped by month
GET gallery/albums            physical albums, Favorites and custom albums, with their covers
GET gallery/albums/<id>       one album's photos
GET gallery/trash             what's in the recycle bin
"""

from datetime import datetime

from starcore.ui_contract import format_value

from . import albums as albums_module
from . import configuration
from .albums import AlbumNotFound, albums
from .library import library

MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December")
GROUPS = {"physical": "Folders", "favorites": "Favorites", "virtual": "Albums"}


def _moment(value):
    """An ISO timestamp as a datetime, or None. EXIF capture times carry no time zone: they
    are kept as the camera's own clock, so a photo stays in the month it was taken."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _epoch(moment):
    if moment is None:
        return None
    try:
        return int(moment.timestamp())
    except (OverflowError, OSError, ValueError):
        return None


def _month(moment) -> str:
    if moment is None:
        return "Unknown date"
    local = moment.astimezone() if moment.tzinfo else moment
    return f"{MONTHS[local.month - 1]} {local.year}"


def _camera(metadata: dict):
    make = (metadata.get("camera_make") or "").strip()
    model = (metadata.get("camera_model") or "").strip()
    if make and model.lower().startswith(make.lower()):
        return model
    return " ".join(part for part in (make, model) if part) or None


def item(photo: dict, favorites: set) -> dict:
    """One photo or video as the gallery shows it."""
    metadata = photo.get("metadata") or {}
    taken = _moment(photo.get("captured_at") or photo.get("imported_at"))
    video = photo.get("media_type") == "video"
    width, height = photo.get("width"), photo.get("height")
    favorite = photo["id"] in favorites
    return {
        "id": photo["id"],
        "title": photo.get("filename") or photo["id"],
        "kind": "video" if video else "image",
        "duration": photo.get("duration") if video else None,
        "month": _month(taken),
        "taken": _epoch(taken),
        "date": format_value(_epoch(taken), "date") if taken else None,
        "imported": _epoch(_moment(photo.get("imported_at"))),
        "size": photo.get("size"),
        "dimensions": f"{width} × {height}" if width and height else None,
        "megapixels": f"{metadata['megapixels']} MP" if metadata.get("megapixels") else None,
        "format": (photo.get("format") or "").upper() or None,
        "camera": _camera(metadata),
        "lens": metadata.get("lens_model"),
        "location": metadata.get("gps_coordinates"),
        "folder": photo.get("physical_path"),
        "favorite": favorite,
        "can_favorite": not favorite,
    }


def _favorites(satellite) -> set:
    album = albums(satellite).get(albums_module.FAVORITES_ID)
    return set(album["photo_ids"]) if album else set()


def _summary(count: int, size: int) -> str:
    noun = "item" if count == 1 else "items"
    return f"{count} {noun} · {format_value(size, 'bytes')}" if count else "No photos or videos yet"


def library_view(satellite) -> dict:
    photo_library = library(satellite)
    favorites = _favorites(satellite)
    photos = photo_library.all()
    return {
        "items": [item(photo, favorites) for photo in photos],
        "summary": _summary(len(photos), sum(photo.get("size") or 0 for photo in photos)),
    }


def albums_view(satellite) -> dict:
    """Every album as a tile: physical ones first (a phone's own folders), then Favorites and
    custom albums, the same order the albums route gives."""
    photo_library = library(satellite)
    store = albums(satellite)
    listed = albums_module.physical_albums(satellite, photo_library)
    for album in store.all():
        present = [photo for photo in (photo_library.get(photo_id) for photo_id in album["photo_ids"]) if photo]
        listed.append({"id": album["id"], "name": album["name"], "kind": album.get("kind", "virtual"),
                       "photo_count": len(present), "cover_photo_id": present[0]["id"] if present else None})
    return {"albums": [{
        "id": album["id"],
        "title": album["name"],
        "subtitle": f"{album['photo_count']} {'item' if album['photo_count'] == 1 else 'items'}",
        "group": GROUPS.get(album.get("kind"), "Albums"),
        "cover": album.get("cover_photo_id") or "",
    } for album in listed]}


def album_view(satellite, album_id: str) -> dict:
    """One album's photos; raises AlbumNotFound."""
    photo_library = library(satellite)
    favorites = _favorites(satellite)
    if album_id.startswith(albums_module.PHYSICAL_ID_PREFIX):
        album = albums_module.physical_album_detail(satellite, photo_library, album_id)
        photos = album["photos"]
        kind = "physical"
    else:
        store = albums(satellite)
        album = store.get(album_id)
        if album is None:
            raise AlbumNotFound(f"unknown album '{album_id}'")
        photos = [photo for photo in (photo_library.get(photo_id) for photo_id in album["photo_ids"]) if photo]
        kind = album.get("kind", "virtual")
    custom = kind == "virtual"
    return {
        "id": album["id"],
        "name": album["name"],
        "kind": kind,
        "summary": _summary(len(photos), sum(photo.get("size") or 0 for photo in photos)),
        # only a custom album is renamed, deleted or has photos taken out of it here;
        # Favorites are left with the favourite action, a physical album follows its folder
        "editable": custom,
        "description": {
            "physical": "A folder on your phone, kept in step by phone sync.",
            "favorites": "Everything you marked as a favourite.",
        }.get(kind),
        "items": [{**item(photo, favorites), "removable": custom} for photo in photos],
    }


def trash_view(satellite) -> dict:
    photo_library = library(satellite)
    retention = configuration.trash_retention_days(satellite)
    photos = photo_library.trashed(retention)
    items = []
    for photo in photos:
        entry = item(photo, set())
        entry["trashed"] = _epoch(_moment(photo.get("trashed_at")))
        items.append(entry)
    days = "day" if retention == 1 else "days"
    return {
        "items": items,
        "summary": _summary(len(items), sum(photo.get("size") or 0 for photo in photos)),
        "note": f"Items are deleted for good {retention} {days} after they were moved here.",
    }
