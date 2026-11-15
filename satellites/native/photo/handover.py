"""media.gallery's server-side operations: handing an item's original over, letting an item go
for good once a verified copy lives elsewhere, and taking a file back in.

This is how a protected store (a media.vault provider) moves media into and out of the library
without importing it: it asks through the Engine (starcore.capabilities.call), which sets the
request's caller. A client's request never has one, so each operation here refuses clients.
This module names no other Satellite and knows nothing of the store beyond the capability.
"""

from pathlib import Path
import hashlib
import os
import secrets

from starcore.api.response import error_response, file_response, json_response
from starcore.capabilities import refuse_clients

from . import sync
from .albums import albums
from .images import UnsupportedImage
from .library import ID_LENGTH, PhotoImportError, PhotoNotFound, library
from .private_media import policy

READ_SIZE = 1024 * 1024
HANDED_OVER = "private, no-store"


def _kind(photo: dict) -> str:
    return "video" if photo.get("media_type") == "video" else "image"


def original(request):
    """GET media/original/<id> -> the stored original of an item in the active library, as a
    file whose download name is the item's filename; 404 for anything else (the recycle bin
    included)."""
    refused = refuse_clients(request)
    if refused is not None:
        return refused
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if len(request.path) != 2 or not 0 < len(request.path[1]) <= 128:
        return error_response("name one item: media/original/<id>", status=404)
    photo_library = library(request.satellite)
    photo = photo_library.get(request.path[1])
    if photo is None:
        return error_response("no such photo in the library", status=404)
    path = photo_library.original_path(photo)
    return file_response(path, photo_library.content_type(photo), HANDED_OVER,
                         download_name=photo.get("filename") or path.name)


def release(request):
    """POST media/release {id, sha256} -> {released: id}: the item leaves the library for good,
    without going through the recycle bin (which would leave a second, visible copy), and out
    of every album, because a verified copy now lives elsewhere. Checked under the library's
    own lock: an item binned, erased or moved meanwhile, or whose stored original no longer has
    this digest, is refused (409) and left as it is."""
    refused = refuse_clients(request)
    if refused is not None:
        return refused
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    body = request.body if isinstance(request.body, dict) else {}
    photo_id, expected = body.get("id"), body.get("sha256")
    if not isinstance(photo_id, str) or not isinstance(expected, str) or not 0 < len(photo_id) <= 128:
        return error_response("'id' and 'sha256' are required", status=400)

    photo_library = library(request.satellite)
    photo = photo_library.get(photo_id)
    if photo is None:
        return error_response("it is no longer in the library", status=409)
    if _digest(photo_library.original_path(photo)) != expected:
        return error_response("the stored original does not match, so it was left in the library", status=409)
    try:
        photo_library.remove_moved(photo_id)
    except PhotoNotFound:
        return error_response("it is no longer in the library", status=409)
    _forget_in_albums(request.satellite, photo_library)
    return json_response({"released": photo_id})


def _forget_in_albums(satellite, photo_library):
    """Drops items the library no longer holds from every album (Favorites included), so no
    album keeps pointing at media that left."""
    store = albums(satellite)
    known = photo_library.all_ids()
    for album in store.all():
        store.prune_missing(album["id"], known)


def adopt(request):
    """POST media/adopt?name=&modified= with the file as a raw body -> {id, kind, added}: takes
    the file in as an import would, through the same checks (media a protected store holds is
    refused), and brings it back from the recycle bin if the same item was there. `added` says
    whether this created the item (an item already in the library is left as it was).

    Written aside under the library's own storage first, and removed again whatever happens."""
    refused = refuse_clients(request)
    if refused is not None:
        return refused
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    raw = request.raw
    if raw is None or getattr(raw, "length", 0) <= 0:
        return error_response("expected the file as a raw body", status=400)
    filename = sync.safe_filename(request.query.get("name"))

    photo_library = library(request.satellite)
    incoming = photo_library.root / sync.INCOMING
    incoming.mkdir(parents=True, exist_ok=True)
    partial = incoming / f"{secrets.token_hex(8)}.part"
    try:
        full_digest = _receive(raw, partial)
        if full_digest is None:
            return error_response("the file was cut short, so nothing was taken in", status=400)
        _keep_modified(partial, request.query.get("modified"))
        try:
            added = photo_library.add_file(partial, filename=filename, private=policy(request.engine))
        except UnsupportedImage as error:
            return error_response(str(error), status=415)
        except PhotoImportError as error:
            return error_response(str(error), status=400)
    finally:
        partial.unlink(missing_ok=True)

    photo = added or photo_library.get_any(full_digest[:ID_LENGTH])
    if photo is None:
        # refused as a duplicate would be, with nothing in the library: a protected store holds it
        return error_response("this file is held elsewhere, so it was not taken in", status=409)
    if photo.get("trashed_at"):
        # the same item was in the recycle bin: bring it back rather than leave the only copy there
        photo = photo_library.restore(photo["id"])
    return json_response({"id": photo["id"], "kind": _kind(photo), "added": added is not None})


def _receive(raw, partial: Path):
    """Writes the raw body to `partial`; its SHA-256, or None when it was cut short."""
    hasher = hashlib.sha256()
    remaining = raw.length
    with open(partial, "wb") as out:
        while remaining > 0:
            chunk = raw.read(min(READ_SIZE, remaining))
            if not chunk:
                return None
            remaining -= len(chunk)
            hasher.update(chunk)
            out.write(chunk)
        out.flush()
        os.fsync(out.fileno())
    return hasher.hexdigest()


def _keep_modified(path: Path, modified):
    """The file's modification time as the caller had it (seconds since the epoch), so an item
    taken back keeps the date it had."""
    try:
        seconds = float(modified)
    except (TypeError, ValueError):
        return
    if 0 < seconds < 1e11:
        os.utime(path, (seconds, seconds))


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(READ_SIZE), b""):
            hasher.update(chunk)
    return hasher.hexdigest()
