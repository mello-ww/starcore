"""Mission Control routes, served under /api/satellites/photo/."""

from starcore.api.response import error_response, file_response, json_response

from . import images, sync
from .library import PhotoImportError, library

# photos are addressed by the digest of their content, so a stored file can be
# cached by the browser for as long as it likes
IMMUTABLE = "private, max-age=604800"


def routes() -> dict:
    return {
        "library": summary,
        "photos": photos,
        "thumbnails": thumbnails,
        "originals": originals,
        "scan": scan,
        "import": import_directory,
        "sync": sync_status,
    }


def sync_status(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    return json_response(sync.describe(request.satellite))


def summary(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    return json_response(library(request.satellite).summary())


def photos(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    photo_library = library(request.satellite)
    if not request.path:
        return json_response({"photos": photo_library.all()})

    photo = photo_library.get(request.path[0])
    if photo is None:
        return error_response(f"unknown photo '{request.path[0]}'")

    return json_response(photo)


def thumbnails(request):
    return _serve(request, thumbnail=True)


def originals(request):
    return _serve(request, thumbnail=False)


def scan(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    source = (request.body or {}).get("source")
    if not isinstance(source, str):
        return error_response("'source' must be a path to a directory on this machine", status=400)

    try:
        return json_response(library(request.satellite).scan(source))
    except PhotoImportError as error:
        return error_response(str(error), status=400)


def import_directory(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    source = (request.body or {}).get("source")
    if not isinstance(source, str):
        return error_response("'source' must be a path to a directory on this machine", status=400)

    try:
        return json_response(library(request.satellite).import_directory(source))
    except PhotoImportError as error:
        return error_response(str(error), status=400)


def _serve(request, thumbnail: bool):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if not request.path:
        return error_response("no photo was requested")

    photo_library = library(request.satellite)
    # only identifiers the index knows are ever turned into a path, so nothing
    # outside the managed storage can be reached from here
    photo = photo_library.get(request.path[0])
    if photo is None:
        return error_response(f"unknown photo '{request.path[0]}'")

    if not thumbnail:
        return file_response(photo_library.original_path(photo), images.CONTENT_TYPES[photo["format"]], IMMUTABLE)

    path = photo_library.thumbnail_path(photo)
    served = "jpeg" if path.suffix == ".jpg" else photo["format"]
    return file_response(path, images.CONTENT_TYPES[served], IMMUTABLE)
