"""Mission Control routes, served under /api/satellites/photo/."""

from starcore.api.response import error_response, file_response, json_response

from . import albums as albums_module
from . import configuration, gallery, sync
from . import state as state_module
from .albums import AlbumError, AlbumNotFound, albums
from .images import UnsupportedImage
from .library import PhotoImportError, PhotoNotFound, library
from .private_media import policy

# photos are addressed by the digest of their content, so a stored file can be
# cached by the browser for as long as it likes
IMMUTABLE = "private, max-age=604800"
# an original served in place of a thumbnail: revalidated every time, see _serve_media()
FALLBACK = "private, no-cache"


def routes() -> dict:
    return {
        "library": summary,
        "photos": photos,
        "thumbnails": thumbnails,
        "originals": originals,
        "scan": scan,
        "import": import_directory,
        "sync": sync_status,
        # the mobile app's automatic background sync uploads through this -
        # see "Real automatic phone sync" in docs/satellites/photo.md and
        # sync.accept_authenticated_upload(). The standalone local-network
        # listener sync.py itself runs (its own token, its own port) is
        # untouched and still what a phone browser can be pointed at
        # directly; this route is a second, authenticated way to reach the
        # exact same ingestion, never a second implementation of it.
        "sync_upload": sync_upload_route,
        "albums": albums_route,
        "trash": trash_route,
        # read-only: the library shaped for ui.json's shared gallery (see gallery.py);
        # every action there goes to the routes above, unchanged
        "gallery": gallery_route,
        # the media.gallery capability's list (see satellite.toml): what a media picker offers
        "media": media_route,
        # naming a route "configuration" is the whole contract with the Core's
        # generic satellite configuration mechanism - see docs/satellites.md
        "configuration": configuration_route,
        # same convention, for a mobile interface - see "Exposing a mobile
        # interface" in docs/satellites.md. StarCore's own mobile app
        # recognizes "Photo" by name and opens its own dedicated gallery
        # screens instead (grid, folders, search, a full-screen viewer) - this
        # is the generic fallback any *other* client gets, the same
        # status-style declarative screen Status's worked example uses.
        "mobile": mobile,
    }


def gallery_route(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    path = tuple(request.path)
    try:
        # every list of photos may be paged (limit, cursor); without them it answers everything
        limit, cursor = gallery.paging(request.query)
        if path == ():
            return json_response(gallery.library_view(request.satellite, limit, cursor))
        if path == ("albums",):
            return json_response(gallery.albums_view(request.satellite))
        if len(path) == 2 and path[0] == "albums":
            return json_response(gallery.album_view(request.satellite, path[1], limit, cursor))
        if path == ("trash",):
            return json_response(gallery.trash_view(request.satellite, limit, cursor))
        if path == ("search",):
            return json_response(gallery.search_view(request.satellite, request.query.get("q"), request.query.get("kind"),
                                                     limit, cursor))
        if path == ("import",):
            return json_response(gallery.import_view(request.satellite))
        if path == ("map",):
            return json_response(gallery.map_view(request.satellite, gallery.viewport(request.query),
                                                  overview=request.query.get("overview") == "1"))
    except AlbumNotFound as error:
        return error_response(str(error), status=404)
    except (gallery.PagingError, gallery.ViewportError) as error:
        return error_response(str(error), status=400)

    return error_response(f"unknown endpoint 'gallery/{'/'.join(path)}'")


def media_route(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if len(request.path) == 2 and request.path[0] == "resolve":
        return resolve_media(request, request.path[1])
    if request.path:
        return error_response(f"unknown endpoint 'media/{'/'.join(request.path)}'")

    try:
        limit, cursor = gallery.paging(request.query)
    except gallery.PagingError as error:
        return error_response(str(error), status=400)
    return json_response(gallery.media_view(request.satellite, request.query.get("kinds"), limit, cursor))


def resolve_media(request, photo_id: str):
    """media.gallery's resolve operation: GET media/resolve/<id> -> {id, kind}, for an item of
    the active library only - never one in the recycle bin, and never one moved into the Locked
    Folder (it has left the library). What the Engine asks before another Satellite acts on a
    reference a client sent (starcore.capabilities.resolve_references)."""
    photo = library(request.satellite).get(photo_id) if 0 < len(photo_id) <= 128 else None
    if photo is None:
        return error_response("no such photo in the library", status=404)
    return json_response({"id": photo["id"], "kind": "video" if photo.get("media_type") == "video" else "image"})


def sync_status(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    return json_response(sync.describe(request.satellite))


def sync_upload_route(request):
    """One photo or video, uploaded from the mobile app's background sync -
    the authenticated counterpart to sync.py's own standalone listener (see
    module docstrings there and "Real automatic phone sync" in
    docs/satellites/photo.md). The filename travels as a query parameter
    (`?filename=...`), the same fallback sync.py's own handler supports,
    since a satellite Request carries no raw headers to read one from
    otherwise; the upload body itself is never JSON, so it arrives as
    request.raw (see starcore.api.response.RawBody) rather than
    request.body.
    """
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if request.raw is None:
        return error_response("expected a raw file upload, not a JSON body", status=400)

    filename = sync.safe_filename(request.query.get("filename"))
    phone_folder = request.query.get("folder")

    try:
        result = sync.accept_authenticated_upload(request.satellite, request.raw, filename, phone_folder=phone_folder)
    except sync.UploadTooLarge as error:
        return error_response(str(error), status=413)
    except ValueError as error:
        return error_response(str(error), status=400)
    except UnsupportedImage as error:
        return error_response(str(error), status=415)
    except RuntimeError as error:
        return error_response(str(error), status=503)

    return json_response(result)


def configuration_route(request):
    if request.method == "GET":
        return json_response(configuration.describe(request.satellite))

    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    body = request.body or {}
    key, value = body.get("key"), body.get("value")
    if not isinstance(key, str):
        return error_response("'key' must be a string", status=400)

    try:
        return json_response(configuration.update(request.engine, request.satellite, key, value))
    except configuration.ConfigurationError as error:
        return error_response(str(error), status=400)


def mobile(request):
    """The generic declarative fallback screen (see "Exposing a mobile
    interface" in docs/satellites.md) - reused only by a client that doesn't
    know Photo specifically. StarCore's own mobile app never calls this: it
    recognizes "Photo" by name and opens its own dedicated screens instead,
    built on the same photos/albums/trash routes as everything else here."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    data = state_module.state(request.engine, request.satellite)

    return json_response({
        "screen": {
            "title": request.satellite.manifest.name,
            "sections": [
                {
                    "type": "card",
                    "items": [
                        {"type": "status", "label": "Photos", "value": str(data.get("photos", "-"))},
                        {"type": "status", "label": "Library size", "value": str(data.get("library_size", "-"))},
                        {"type": "status", "label": "Phone sync", "value": str(data.get("sync", "-"))},
                    ],
                },
            ],
        },
    })


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


def _requested_source(request):
    """The 'source' a scan/import request named, or the satellite's own
    configured photo_directory (see configuration.py) when it didn't name
    one - the default directory only ever applies when a request is silent
    about where to look, never overriding an explicit source."""
    source = (request.body or {}).get("source")
    if source is not None:
        return source

    return request.satellite.config.get("photo_directory", "") or None


def scan(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    source = _requested_source(request)
    if not isinstance(source, str) or not source:
        return error_response("'source' must be a path to a directory on this machine, or configure a "
                               "default photo_directory", status=400)

    try:
        report = library(request.satellite).scan(source, private=policy(request.engine))
    except PhotoImportError as error:
        return error_response(str(error), status=400)
    # `message` is what a client shows after the action (the shared interface's import form)
    return json_response({**report, "message": f"Found {_count(report['found'], 'supported file')}: "
                                               f"{report['new']} new, {report['duplicates']} already in the library."})


def import_directory(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    source = _requested_source(request)
    if not isinstance(source, str) or not source:
        return error_response("'source' must be a path to a directory on this machine, or configure a "
                               "default photo_directory", status=400)

    try:
        report = library(request.satellite).import_directory(source, private=policy(request.engine))
    except PhotoImportError as error:
        return error_response(str(error), status=400)
    failed = len(report["failed"])
    message = f"Imported {_count(report['imported'], 'item')}, {report['duplicates']} already in the library"
    message += f", {failed} failed." if failed else "."
    return json_response({**report, "message": message})


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"



def albums_route(request):
    store = albums(request.satellite)

    if request.method == "GET":
        return _albums_get(request, store)
    if request.method == "POST":
        return _albums_post(request, store)

    return error_response("only GET and POST are supported here", status=405)


def _albums_get(request, store):
    photo_library = library(request.satellite)

    if not request.path:
        # physical albums first, then virtual/Favorites - see
        # docs/satellites/photo.md, "Albums": the UI groups by "kind" itself,
        # but listing physical ones first keeps the common case (a phone's
        # own folder structure) at the top
        physical = albums_module.physical_albums(request.satellite, photo_library)
        virtual = [_album_summary(album, photo_library) for album in store.all()]
        return json_response({"albums": physical + virtual})

    if len(request.path) != 1:
        return error_response(f"unknown endpoint 'albums/{'/'.join(request.path)}'")

    album_id = request.path[0]
    if album_id.startswith(albums_module.PHYSICAL_ID_PREFIX):
        try:
            return json_response(albums_module.physical_album_detail(request.satellite, photo_library, album_id))
        except AlbumNotFound as error:
            return error_response(str(error), status=404)

    album = store.get(album_id)
    if album is None:
        return error_response(f"unknown album '{album_id}'")

    # all_ids(), not all() - a photo the recycle bin is holding is still
    # physically in the library, so it must not be pruned from its albums;
    # it just doesn't show up in "photos" below until restored or erased
    known_ids = photo_library.all_ids()
    album = store.prune_missing(album["id"], known_ids)
    photos_in_album = [photo_library.get(photo_id) for photo_id in album["photo_ids"]]
    return json_response({**album, "photos": [photo for photo in photos_in_album if photo is not None]})


def _albums_post(request, store):
    body = request.body or {}

    if not request.path:
        try:
            return json_response(store.create(body.get("name")))
        except AlbumError as error:
            return error_response(str(error), status=400)

    album_id = request.path[0]
    action = tuple(request.path[1:])

    if album_id.startswith(albums_module.PHYSICAL_ID_PREFIX):
        return error_response("a physical album is derived from Photo configuration's source paths and can't "
                               "be edited directly - add, remove or edit a source path instead", status=400)

    try:
        if action == ():
            return json_response(store.rename(album_id, body.get("name")))

        if action == ("delete",):
            store.delete(album_id)
            return json_response({"deleted": album_id})

        if action == ("photos",):
            return _album_add_photo(request, store, album_id, body)

        if action == ("photos", "remove"):
            photo_id = body.get("photo_id")
            if not isinstance(photo_id, str) or not photo_id:
                return error_response("'photo_id' must be a string", status=400)
            return json_response(store.remove_photo(album_id, photo_id))
    except AlbumNotFound as error:
        return error_response(str(error), status=404)
    except AlbumError as error:
        return error_response(str(error), status=400)

    return error_response(f"unknown endpoint 'albums/{'/'.join(request.path)}'")


def _album_add_photo(request, store, album_id, body):
    if "items" in body:
        # what the media picker chose (the pick action): references to this library's own
        # media.gallery, added together; the photo_id form below is unchanged
        try:
            photo_ids = gallery.picked_ids(request.satellite, body["items"])
        except ValueError as error:
            return error_response(str(error), status=400)
        album = store.get(album_id)
        if album is None:
            raise AlbumNotFound(f"unknown album '{album_id}'")
        for photo_id in photo_ids:
            album = store.add_photo(album_id, photo_id)
        count = len(photo_ids)
        return json_response({**album, "message": f"Added {count} {'item' if count == 1 else 'items'}."})

    photo_id = body.get("photo_id")
    if not isinstance(photo_id, str) or not photo_id:
        return error_response("'photo_id' must be a string", status=400)

    if library(request.satellite).get(photo_id) is None:
        return error_response(f"unknown photo '{photo_id}'", status=400)

    return json_response(store.add_photo(album_id, photo_id))


def _album_summary(album, photo_library) -> dict:
    present = [photo_library.get(photo_id) for photo_id in album["photo_ids"]]
    present = [photo for photo in present if photo is not None]
    return {
        "id": album["id"],
        "name": album["name"],
        "kind": album.get("kind", "virtual"),
        "created_at": album["created_at"],
        "updated_at": album["updated_at"],
        "photo_count": len(present),
        "cover_photo_id": present[0]["id"] if present else None,
    }


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

    return _serve_media(photo_library, photo, thumbnail)


def _serve_media(photo_library, photo, thumbnail: bool):
    """Shared by the normal originals/thumbnails routes and the recycle
    bin's own preview routes - one place that knows a rendered thumbnail is
    always a JPEG regardless of the source's own format, and that a video
    with no thumbnail available (see PhotoLibrary.thumbnail_path) has
    nothing to fall back to the way an un-thumbnailed photo falls back to
    its own original."""
    if not thumbnail:
        return file_response(photo_library.original_path(photo), photo_library.content_type(photo), IMMUTABLE)

    path = photo_library.thumbnail_path(photo)
    if path is None:
        return error_response(f"no thumbnail is available for '{photo['id']}' "
                               "(ffmpeg isn't installed on this StarCore server)", status=404)

    if path.suffix == ".jpg" and path.parent.parent == photo_library.thumbnails_dir:
        return file_response(path, "image/jpeg", IMMUTABLE)

    # No thumbnail could be rendered (no Pillow), so this is the original standing in for one.
    # It must not be cached under the thumbnail URL: once Pillow is installed, browsers and
    # the app's image cache would otherwise keep the full-size original for a week.
    return file_response(path, photo_library.content_type(photo), FALLBACK)


def trash_route(request):
    """The recycle bin: GET lists what's in it (and previews a trashed
    photo's thumbnail/original); POST moves a photo in, restores one, or
    permanently erases one. A photo already in the bin is otherwise invisible
    everywhere else in the API - see PhotoLibrary.get()."""
    if request.method == "GET":
        return _trash_get(request)
    if request.method == "POST":
        return _trash_post(request)

    return error_response("only GET and POST are supported here", status=405)


def _trash_get(request):
    photo_library = library(request.satellite)

    if not request.path:
        retention_days = configuration.trash_retention_days(request.satellite)
        return json_response({
            "photos": photo_library.trashed(retention_days),
            "retention_days": retention_days,
        })

    if len(request.path) == 2 and request.path[1] in ("thumbnail", "original"):
        photo = photo_library.get_any(request.path[0])
        if photo is None or not photo.get("trashed_at"):
            return error_response(f"unknown photo '{request.path[0]}' in the recycle bin", status=404)

        return _serve_media(photo_library, photo, thumbnail=request.path[1] == "thumbnail")

    return error_response(f"unknown endpoint 'trash/{'/'.join(request.path)}'")


def _trash_post(request):
    if not request.path:
        return error_response("no photo id was given")

    photo_library = library(request.satellite)
    photo_id = request.path[0]
    action = tuple(request.path[1:])

    try:
        if action == ():
            if photo_library.get(photo_id) is None:
                return error_response(f"unknown photo '{photo_id}'", status=404)
            return json_response(photo_library.trash(photo_id))

        if action == ("restore",):
            return json_response(photo_library.restore(photo_id))

        if action == ("erase",):
            photo_library.erase(photo_id)
            return json_response({"erased": photo_id})
    except PhotoNotFound as error:
        return error_response(str(error), status=404)

    return error_response(f"unknown endpoint 'trash/{'/'.join(request.path)}'")
