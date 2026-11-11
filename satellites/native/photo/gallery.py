"""The library shaped for Photo's ui.json (UI contract 1.2's media-grid).

UI documents have no expression language, so this is the one Photo-specific step between the
library and the shared gallery: it decides what a tile and the viewer show (the month a photo
belongs to, its dimensions and camera as text, whether it is a favourite) and nothing else. It
reads the same library, albums and recycle bin as every other route, through the same
functions, and never writes: every action in the document goes to the existing routes
(albums/favorites/photos, trash/<id>, ...), unchanged.

GET gallery                   every active photo and video, newest first, grouped by month
GET gallery/albums            physical albums, Favorites and custom albums, with their covers
GET gallery/albums/<id>       one album's photos, in the album's own order
GET gallery/trash             what's in the recycle bin, with the days each item has left
GET gallery/import            the default import folder and the formats an import takes in
GET gallery/search?q=&kind=   photos and albums matching a search, for the shared Search page
GET gallery/map               every photo with a location, for the shared Map page
GET media?kinds=              the media.gallery capability's list: what a picker may offer

Every list of photos also takes `limit` (1-500) and `cursor`: it then answers one page, with the
cursor of the next in `next` (null at the end). Without `limit` it answers everything, as it
always did. The cursor is the position of the page's last photo in a fixed order (newest first,
then by id), not a page number: a photo added or removed between two pages never makes another
one appear twice or go missing. An album keeps its own order instead (see page_in_order()). The
map takes `bbox` and `zoom` instead (see map_view()).
"""

import base64
import binascii
import json
import math
from datetime import datetime, timezone

from starcore import capabilities
from starcore.ui_contract import format_value

from . import albums as albums_module
from . import configuration
from .albums import AlbumNotFound, albums
from . import images, videos
from .library import library

MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December")
# Favorites sits with the folders, pinned first (albums_view)
GROUPS = {"physical": "Folders", "favorites": "Folders", "virtual": "Albums"}


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


PAGE_LIMIT = 500


class PagingError(ValueError):
    """A `limit`, `cursor` or `group` that can't be used: answered with 400."""


def paging(query) -> tuple:
    """(limit or None, cursor or None) from a request's query string."""
    raw_limit, raw_cursor = query.get("limit"), query.get("cursor")
    limit = None
    if raw_limit not in (None, ""):
        try:
            limit = int(raw_limit)
        except ValueError:
            raise PagingError("'limit' must be a whole number")
        if not 1 <= limit <= PAGE_LIMIT:
            raise PagingError(f"'limit' must be between 1 and {PAGE_LIMIT}")
    cursor = None
    if raw_cursor not in (None, ""):
        if limit is None:
            raise PagingError("a 'cursor' needs a 'limit'")
        try:
            cursor = tuple(json.loads(base64.urlsafe_b64decode(raw_cursor + "=" * (-len(raw_cursor) % 4))))
        except (ValueError, binascii.Error, TypeError):
            raise PagingError("'cursor' is not one this list gave")
        if len(cursor) != 2 or not all(isinstance(part, str) for part in cursor):
            raise PagingError("'cursor' is not one this list gave")
    return limit, cursor


def _cursor(key: tuple) -> str:
    return base64.urlsafe_b64encode(json.dumps(list(key), separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")


def _newest_first(photo: dict) -> tuple:
    """The fixed order every list pages through: newest first, then by id - so two photos taken
    at the same moment always come in the same order."""
    return (photo.get("captured_at") or photo.get("imported_at") or "", photo["id"])


def page(photos: list, limit, cursor, key=_newest_first) -> tuple:
    """(this page of `photos`, the next cursor or None). `photos` is sorted by `key`,
    descending; the page starts after the cursor's position in that order (keyset paging)."""
    ordered = sorted(photos, key=key, reverse=True)
    if limit is None:
        return ordered, None
    start = 0
    if cursor is not None:
        # the first photo strictly after the cursor: binary search in a descending order
        low, high = 0, len(ordered)
        while low < high:
            middle = (low + high) // 2
            if key(ordered[middle]) < cursor:
                high = middle
            else:
                low = middle + 1
        start = low
    chosen = ordered[start:start + limit]
    more = start + limit < len(ordered)
    return chosen, (_cursor(key(chosen[-1])) if more and chosen else None)


def page_in_order(photos: list, limit, cursor) -> tuple:
    """(this page of `photos`, the next cursor or None), keeping `photos` in the order given -
    an album's own order. The cursor holds the last photo's id and its position: the next page
    starts after that photo, or, if it has left the album since, where it was."""
    if limit is None:
        return list(photos), None
    start = 0
    if cursor is not None:
        position, last_id = cursor
        if not position.isdigit():
            raise PagingError("'cursor' is not one this list gave")
        ids = [photo["id"] for photo in photos]
        # gone: whatever followed it has moved up into its place
        start = ids.index(last_id) + 1 if last_id in ids else min(int(position), len(photos))
    chosen = photos[start:start + limit]
    end = start + len(chosen)
    more = end < len(photos)
    return chosen, (_cursor((str(end - 1), chosen[-1]["id"])) if more and chosen else None)


def _favorites(satellite) -> set:
    album = albums(satellite).get(albums_module.FAVORITES_ID)
    return set(album["photo_ids"]) if album else set()


def _summary(count: int, size: int) -> str:
    noun = "item" if count == 1 else "items"
    return f"{count} {noun} · {format_value(size, 'bytes')}" if count else "No photos or videos yet"


# how the Library groups its photos, as Photo's own page did: by month (newest first), by
# camera (alphabetical, an unknown one last, each newest first), or not at all
GROUPINGS = ("month", "camera", "all")
UNKNOWN_CAMERA = "Unknown camera"


def library_view(satellite, limit=None, cursor=None, group="month") -> dict:
    if group not in GROUPINGS:
        raise PagingError("'group' must be month, camera or all")
    photo_library = library(satellite)
    favorites = _favorites(satellite)
    photos = photo_library.all()
    if group == "camera":
        # newest first within each camera; paged by position, since the order is no longer by date
        newest = sorted(photos, key=_newest_first, reverse=True)
        label = lambda photo: _camera(photo.get("metadata") or {})
        ordered = sorted(newest, key=lambda photo: (label(photo) is None, (label(photo) or "").lower()))
        shown, following = page_in_order(ordered, limit, cursor)
    else:
        shown, following = page(photos, limit, cursor)
    items = [item(photo, favorites) for photo in shown]
    for entry in items:
        entry["group"] = entry["month"] if group == "month" else (entry["camera"] or UNKNOWN_CAMERA) if group == "camera" else None
    return {
        "items": items,
        "next": following,
        "summary": _summary(len(photos), sum(photo.get("size") or 0 for photo in photos)),
    }


# the Locked Folder as a folder among the others, while a media.vault provider is there: a lock
# instead of a cover, and nothing about what it holds - it is never listed here. ui.json opens
# it through Photo's own interface ("locked"), which asks for its PIN
VAULT_TILE = {"id": "locked", "title": "Locked Folder", "subtitle": "Behind your PIN",
              "group": "Folders", "cover": "", "icon": "lock", "locked": True}


def albums_view(satellite, engine=None) -> dict:
    """Every album as a tile: Favorites pinned first, then the Locked Folder (while there is
    one), then the phone's own folders - together under "Folders" - then the custom albums. A
    client groups consecutive tiles, so Favorites always heads the Folders group."""
    photo_library = library(satellite)
    store = albums(satellite)
    listed = albums_module.physical_albums(satellite, photo_library)
    for album in store.all():
        present = [photo for photo in (photo_library.get(photo_id) for photo_id in album["photo_ids"]) if photo]
        listed.append({"id": album["id"], "name": album["name"], "kind": album.get("kind", "virtual"),
                       "photo_count": len(present), "cover_photo_id": present[0]["id"] if present else None})
    listed.sort(key=lambda album: {"favorites": 0, "physical": 1}.get(album.get("kind"), 2))  # stable: keeps each kind's order
    tiles = [{
        "id": album["id"],
        "title": album["name"],
        "subtitle": f"{album['photo_count']} {'item' if album['photo_count'] == 1 else 'items'}",
        "group": GROUPS.get(album.get("kind"), "Albums"),
        "cover": album.get("cover_photo_id") or "",
    } for album in listed]
    if engine is not None and capabilities.provider(engine, "media.vault")[0] is not None:
        pinned = sum(1 for album in listed if album.get("kind") == "favorites")
        tiles.insert(pinned, dict(VAULT_TILE))
    return {"albums": tiles}


def album_view(satellite, album_id: str, limit=None, cursor=None) -> dict:
    """One album's photos, newest first; raises AlbumNotFound."""
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
    # the album's own order (when photos were added, or the folder's), like Photo's own screens
    shown, following = page_in_order(photos, limit, cursor)
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
        "items": [{**item(photo, favorites), "removable": custom} for photo in shown],
        "next": following,
    }


def _matches(photo: dict, query: str) -> bool:
    """The same fields the app's own Search tab looks in (PhotoSearchTab.matches()): the file
    name, the camera and lens, and the capture date."""
    metadata = photo.get("metadata") or {}
    haystack = " ".join(str(value) for value in (
        photo.get("filename"), metadata.get("camera_make"), metadata.get("camera_model"),
        metadata.get("lens_model"), photo.get("captured_at"),
    ) if value).lower()
    return query in haystack


def search_view(satellite, query=None, kind=None, limit=None, cursor=None) -> dict:
    """Photos and albums matching `query`, for the shared Search page. Nothing is listed until
    there is something to look for; `kind` (image, video, or all) narrows the photos."""
    text = (query or "").strip().lower()
    if not text:
        return {"items": [], "next": None, "albums": [], "prompt": "Type to search your library.", "summary": None}
    favorites = _favorites(satellite)
    photos = [photo for photo in library(satellite).all() if _matches(photo, text)]
    if kind in ("image", "video"):
        photos = [photo for photo in photos if ("video" if photo.get("media_type") == "video" else "image") == kind]
    # album names are matched on the first page only: they are few, and the later pages are photos
    albums = [album for album in albums_view(satellite)["albums"] if text in album["title"].lower()] if cursor is None else []
    count = len(photos)
    shown, following = page(photos, limit, cursor)
    summary = (f"{count} {'result' if count == 1 else 'results'}" if count
               else None if albums else "No photos match your search.")
    return {"items": [item(photo, favorites) for photo in shown], "next": following, "albums": albums,
            "prompt": None, "summary": summary}


# a viewport with at most this many photos gets them all; more are grouped into clusters
VIEWPORT_ITEMS = 300
# a cluster covers about this many pixels of the map, as the clients cluster on their own
CLUSTER_PIXELS = 64


class ViewportError(ValueError):
    """A `bbox` or `zoom` that can't be used: answered with 400."""


def _located(photo: dict):
    metadata = photo.get("metadata") or {}
    lat, lon = metadata.get("gps_latitude"), metadata.get("gps_longitude")
    if isinstance(lat, bool) or isinstance(lon, bool) or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    return (lat, lon) if -90 <= lat <= 90 and -180 <= lon <= 180 else None


def viewport(query) -> tuple:
    """(south, west, north, east, zoom) from `bbox` and `zoom`, or None without them."""
    raw_bbox, raw_zoom = query.get("bbox"), query.get("zoom")
    if raw_bbox in (None, "") and raw_zoom in (None, ""):
        return None
    try:
        south, west, north, east = (float(part) for part in str(raw_bbox).split(","))
        zoom = float(raw_zoom)
    except (TypeError, ValueError):
        raise ViewportError("'bbox' must be south,west,north,east and 'zoom' a number")
    if not (-90 <= south <= north <= 90 and -180 <= west <= 180 and -180 <= east <= 180 and 0 <= zoom <= 24):
        raise ViewportError("'bbox' or 'zoom' is out of range")
    return south, west, north, east, zoom


def map_view(satellite, area=None, overview=False) -> dict:
    """The located photos, for the shared Map page - the same photos the Map tabs of Photo's own
    page and screens plot; one without GPS metadata is left out.

    - Without `area` (and not `overview`): every located photo, as before.
    - `overview`: no photos, only their count and `bounds` ([south, west, north, east]), so a
      map can fit them before it asks for what is on screen.
    - With `area` (south, west, north, east, zoom): the photos in that rectangle. Up to
      VIEWPORT_ITEMS come one by one; beyond that, those that share a cell of a grid about
      CLUSTER_PIXELS wide at this zoom come as one cluster ({count, bounds, cover}), so a map
      of any library stays a bounded answer and nothing on screen is left out.
    """
    favorites = _favorites(satellite)
    located = [(photo, spot) for photo in library(satellite).all() if (spot := _located(photo))]
    count = len(located)
    summary = f"{count} {'item' if count == 1 else 'items'} with a location" if count else None
    if overview:
        bounds = None
        if located:
            lats = [spot[0] for _, spot in located]
            lons = [spot[1] for _, spot in located]
            bounds = [min(lats), min(lons), max(lats), max(lons)]
        return {"items": [], "bounds": bounds, "count": count, "summary": summary}
    if area is None:
        return {"items": [{**item(photo, favorites), "lat": spot[0], "lon": spot[1], "count": 1, "cover": photo["id"]}
                          for photo, spot in located], "summary": summary}

    south, west, north, east, zoom = area

    def inside(spot):
        lat, lon = spot
        across = west <= lon <= east if west <= east else (lon >= west or lon <= east)  # across the antimeridian
        return south <= lat <= north and across

    shown = [(photo, spot) for photo, spot in located if inside(spot)]
    single = lambda photo, spot: {**item(photo, favorites), "lat": spot[0], "lon": spot[1], "count": 1, "cover": photo["id"]}
    if len(shown) <= VIEWPORT_ITEMS:
        return {"items": [single(photo, spot) for photo, spot in shown], "summary": summary, "visible": len(shown)}
    cell = (360 / 2 ** zoom) * (CLUSTER_PIXELS / 256)
    cells = {}
    for photo, spot in shown:
        cells.setdefault((int(spot[0] // cell), int(spot[1] // cell)), []).append((photo, spot))
    items = []
    for (row, column), members in cells.items():
        if len(members) == 1:
            items.append(single(*members[0]))
            continue
        lats = [spot[0] for _, spot in members]
        lons = [spot[1] for _, spot in members]
        newest = max(members, key=lambda member: _newest_first(member[0]))[0]
        items.append({
            "id": f"cluster:{zoom:g}:{row}:{column}",
            "title": f"{len(members)} items",
            "lat": sum(lats) / len(lats),
            "lon": sum(lons) / len(lons),
            "count": len(members),
            "bounds": [min(lats), min(lons), max(lats), max(lons)],
            "cover": newest["id"],
            "kind": "image",
        })
    return {"items": items, "summary": summary, "visible": len(shown)}


def media_view(satellite, kinds=None, limit=None, cursor=None) -> dict:
    """media.gallery v1's `list`: the active library, newest first, as a picker shows it. Only
    the active library - a photo in the recycle bin, or anything the Locked Folder holds, is
    never in it (see library.all() and private_media.py), so a picker can't offer it."""
    wanted = {kind for kind in (kinds or "").split(",") if kind in ("image", "video")} or {"image", "video"}
    offered = [photo for photo in library(satellite).all()
               if ("video" if photo.get("media_type") == "video" else "image") in wanted]
    shown, following = page(offered, limit, cursor)
    items = []
    for photo in shown:
        kind = "video" if photo.get("media_type") == "video" else "image"
        items.append({
            "id": photo["id"],
            "kind": kind,
            "title": photo.get("filename") or photo["id"],
            "duration": photo.get("duration") if kind == "video" else None,
            "group": _month(_moment(photo.get("captured_at") or photo.get("imported_at"))),
        })
    return {"items": items, "next": following}


def picked_ids(satellite, items) -> list:
    """The photo ids in a picker's references ([{provider, capability, id, kind}]): only
    references to this Satellite's own media.gallery, and only to photos the active library
    has. Raises ValueError for anything else - a reference never names a path."""
    if not isinstance(items, list) or not items:
        raise ValueError("'items' must be a non-empty list of picked media")
    photo_library = library(satellite)
    ids = []
    for reference in items:
        if not isinstance(reference, dict):
            raise ValueError("each picked item must be an object")
        if reference.get("provider") != satellite.manifest.name or reference.get("capability") != "media.gallery":
            raise ValueError("only media picked from this library can be added to its albums")
        photo_id = reference.get("id")
        if not isinstance(photo_id, str) or photo_library.get(photo_id) is None:
            raise ValueError(f"unknown photo '{photo_id}'")
        if photo_id not in ids:
            ids.append(photo_id)
    return ids


def _binned_first(photo: dict) -> tuple:
    """The recycle bin's order: most recently moved there first, then by id."""
    return (photo.get("trashed_at") or "", photo["id"])


def days_left(trashed_at, retention_days, now=None):
    """How long a binned item has before it is erased for good, in the words Photo's own
    screens use (daysRemaining() in page.js and PhotoTrashTab.tsx), or None if unknown."""
    trashed = _moment(trashed_at)
    if trashed is None or retention_days is None:
        return None
    if trashed.tzinfo is None:
        trashed = trashed.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    elapsed = (now - trashed).total_seconds() / 86400
    remaining = max(0, math.ceil(retention_days - elapsed))
    if remaining <= 0:
        return "Erasing soon"
    return f"{remaining} day{'' if remaining == 1 else 's'} left"


def trash_view(satellite, limit=None, cursor=None) -> dict:
    photo_library = library(satellite)
    retention = configuration.trash_retention_days(satellite)
    photos = photo_library.trashed(retention)
    shown, following = page(photos, limit, cursor, key=_binned_first)
    now = datetime.now(timezone.utc)
    items = []
    for photo in shown:
        entry = item(photo, set())
        entry["trashed"] = _epoch(_moment(photo.get("trashed_at")))
        entry["left"] = days_left(photo.get("trashed_at"), retention, now)
        items.append(entry)
    days = "day" if retention == 1 else "days"
    return {
        "items": items,
        "next": following,
        "summary": _summary(len(photos), sum(photo.get("size") or 0 for photo in photos)),
        "note": f"Items are deleted for good {retention} {days} after they were moved here.",
    }


def import_view(satellite) -> dict:
    """What the shared Import page shows: the configured default folder (pre-filled, as on
    Photo's own page) and the formats an import takes in."""
    formats = sorted(set(images.EXTENSIONS) | set(videos.EXTENSIONS))
    return {
        "directory": satellite.config.get("photo_directory", "") or "",
        "formats": f"Takes in {', '.join(name.upper() for name in formats)} files. Originals are never moved, "
                   "changed or deleted, and importing the same folder twice is safe.",
    }
