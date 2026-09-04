"""Mission Control routes, served under /api/satellites/music/."""

from starcore.api.response import error_response, file_response, json_response

from . import audio, configuration
from .library import MusicScanError, library

# a track is addressed by a digest of its content, so what comes back can be cached
IMMUTABLE = "private, max-age=604800"


def routes() -> dict:
    return {
        "library": summary,
        "tracks": tracks,
        "albums": albums,
        "artists": artists,
        "artwork": artwork,
        "stream": stream,
        "scan": scan,
        # naming a route "configuration" is the whole contract with the Core's
        # generic satellite configuration mechanism - see docs/satellites.md
        "configuration": configuration_route,
    }


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
        return json_response(configuration.update(request.satellite, key, value))
    except configuration.ConfigurationError as error:
        return error_response(str(error), status=400)


def summary(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    return json_response(library(request.satellite).summary())


def tracks(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    music = library(request.satellite)
    if not request.path:
        return json_response({"tracks": music.tracks()})

    track = music.track(request.path[0])
    if track is None:
        return error_response(f"unknown track '{request.path[0]}'")

    return json_response(track)


def albums(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    music = library(request.satellite)
    if not request.path:
        return json_response({"albums": music.albums()})

    album = music.album(request.path[0])
    if album is None:
        return error_response(f"unknown album '{request.path[0]}'")

    return json_response(album)


def artists(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    return json_response({"artists": library(request.satellite).artists()})


def artwork(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if not request.path:
        return error_response("no album was requested")

    music = library(request.satellite)
    album = music.album(request.path[0])
    if album is None:
        return error_response(f"unknown album '{request.path[0]}'")

    path = music.artwork_path(album)
    if path is None:
        return error_response("this album has no cover art")

    return file_response(path, "image/png" if path.suffix == ".png" else "image/jpeg", IMMUTABLE)


def stream(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if not request.path:
        return error_response("no track was requested")

    music = library(request.satellite)
    # only identifiers the index knows become a path, so nothing else on the disk
    # can be reached through this route
    track = music.track(request.path[0])
    if track is None:
        return error_response(f"unknown track '{request.path[0]}'")

    try:
        path = music.track_path(track)
    except MusicScanError as error:
        return error_response(str(error))

    return file_response(path, audio.CONTENT_TYPES[track["format"]], IMMUTABLE)


def _requested_source(request):
    """The 'source' a scan request named, or the satellite's own configured
    library directory (see configuration.py) when it didn't name one - read
    fresh from config on every call so a change saved through the
    configuration route takes effect on the very next scan, even though the
    MusicLibrary instance itself is cached for the satellite's lifetime."""
    source = (request.body or {}).get("source")
    if source is not None:
        return source

    return request.satellite.config.get("library", "~/Music")


def scan(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    source = _requested_source(request)
    if not isinstance(source, str):
        return error_response("'source' must be a path to a directory on this machine", status=400)

    try:
        return json_response(library(request.satellite).scan(source))
    except MusicScanError as error:
        return error_response(str(error), status=400)
