"""files.open: opening a file by its path, from another interface's "Opens with".

The path comes from a client, so it is never trusted and never read from the disk here: every
question about it goes to whichever Satellite provides `files.browse`, with the user's own
session (starcore.capabilities.call), so that Satellite's roots and the protected areas apply
exactly as when the user browses. A file the user may not browse is a 404, never a hint that it
exists. This module names no other Satellite.

A path opens the `file` page: the picture or the video, read through the browsing Satellite's
`content`, with an "Add to library" action when the library does not hold it yet. A file of a
protected area is shown while the session has the area open (nothing about it is kept), but never
taken into the library: it leaves that area only through the area's own way out.
"""

import mimetypes
from pathlib import PurePath

from starcore import capabilities
from starcore.api.response import error_response, json_response

from . import handover, images
from .library import ID_LENGTH, PhotoImportError, library
from .private_media import policy

# what this Satellite can show, by the file's extension
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".3gp"}
OPENS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp",
}
# kept short and private: the same bytes are served again whenever the file is asked for
VIEWED = "private, no-store"
BROWSE = "files.browse"


def kind_of(path: str) -> str:
    return "video" if PurePath(path).suffix.lower() in VIDEO_EXTENSIONS else "image"


def stat(request, path):
    """(the file's {name, path, size, ...} as the browsing Satellite answers for this session,
    None), or (None, an error response): 404 for everything that is not a supported file the
    session may browse, whatever the reason, so the answer says nothing more than 'not here'."""
    if not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path:
        return None, error_response("name the file's absolute path", status=400)
    if PurePath(path).suffix.lower() not in OPENS:
        return None, error_response("that file can't be opened here", status=404)
    answer = capabilities.call(request.engine, BROWSE, "stat", query={"path": path}, token=request.token)
    payload = getattr(answer, "payload", None)
    if answer is None or answer.status != 200 or not isinstance(payload, dict) or payload.get("type") != "file":
        return None, error_response("that file can't be opened here", status=404)
    return payload, None


def protected(request, path) -> bool:
    """Whether `path` is in a protected area, open for this session or not."""
    return capabilities.protection(request.engine, path, request.token).protected


def open_route(request):
    """POST open {path} -> {page, params}: the page of this interface that shows the file."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    body = request.body if isinstance(request.body, dict) else {}
    found, failure = stat(request, body.get("path"))
    if failure is not None:
        return failure
    return json_response({"page": "file", "params": {"path": found["path"]}})


def in_library(satellite, found: dict):
    """The library's item that is this file, or None: the same name and size, and, when the
    item remembers its folder, the same folder. Looked up in the index, nothing is read."""
    folder = str(PurePath(found["path"]).parent)
    for photo in library(satellite).all():
        if (photo.get("filename") == found["name"] and photo.get("size") == found["size"]
                and photo.get("physical_path") in (None, folder) and photo.get("origin") in (None, folder)):
            return photo
    return None


def file_view(request):
    """gallery/file?path= -> what the `file` page shows."""
    found, failure = stat(request, request.query.get("path"))
    if failure is not None:
        return failure
    photo = in_library(request.satellite, found)
    kind = kind_of(found["path"])
    shielded = protected(request, found["path"])
    return json_response({
        "name": found["name"],
        "path": found["path"],
        "folder": str(PurePath(found["path"]).parent),
        "kind": kind,
        "size": found["size"],
        "is_image": kind == "image",
        "is_video": kind == "video",
        "library_note": ("In the library" if photo is not None else
                         "In a protected area" if shielded else "Not in the library"),
        "can_add": photo is None and not shielded,
        "id": photo["id"] if photo else None,
        # a video is drawn by the shared viewer, from this one tile
        "videos": [{"key": found["path"], "title": found["name"], "kind": kind, "size": found["size"]}]
                  if kind == "video" else [],
    })


def content(request):
    """file/content?path= -> the file's bytes, from the browsing Satellite's `content` once its
    `stat` has passed for this session: served with this Satellite's own content type, inline."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    found, failure = stat(request, request.query.get("path"))
    if failure is not None:
        return failure
    answer = capabilities.call(request.engine, BROWSE, "content", query={"path": found["path"]}, token=request.token)
    if answer is None or answer.status != 200 or getattr(answer, "path", None) is None:
        return error_response("that file can't be opened here", status=404)
    answer.content_type = CONTENT_TYPES.get(PurePath(found["path"]).suffix.lower()) or \
        mimetypes.guess_type(found["path"])[0] or "application/octet-stream"
    answer.download_name = None
    answer.cache = VIEWED
    return answer


def add(request):
    """POST file/add {path} -> {id, added}: takes the file into the library as an import does,
    through the same checks, once the browsing Satellite has let this session read it."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    body = request.body if isinstance(request.body, dict) else {}
    found, failure = stat(request, body.get("path"))
    if failure is not None:
        return failure
    if protected(request, found["path"]):
        # even while the session has the area open: a copy in the library would be outside it
        return error_response("this file is in a protected area, so it can't be added to the library", status=403)
    answer = capabilities.call(request.engine, BROWSE, "content", query={"path": found["path"]}, token=request.token)
    source = getattr(answer, "path", None)
    if answer is None or answer.status != 200 or source is None:
        return error_response("that file can't be opened here", status=404)

    photo_library = library(request.satellite)
    try:
        added = photo_library.add_file(source, filename=found["name"], private=policy(request.engine),
                                       origin=str(PurePath(found["path"]).parent))
    except images.UnsupportedImage:
        return error_response("that file isn't a picture or a video this library can keep", status=415)
    except PhotoImportError as error:
        return error_response(str(error), status=400)
    photo = added or photo_library.get_any(handover.digest(source)[:ID_LENGTH])
    if photo is None:
        # refused as a duplicate would be: a protected store holds it
        return error_response("this file is held elsewhere, so it was not taken in", status=409)
    if photo.get("trashed_at"):
        photo = photo_library.restore(photo["id"])
    return json_response({"id": photo["id"], "added": added is not None,
                          "message": "Added to the library." if added else "It is already in the library."})
