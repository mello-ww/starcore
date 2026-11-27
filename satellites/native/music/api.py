"""Music routes, served under /api/satellites/music/. See docs/satellites/music.md."""

from starcore.api.response import error_response, json_response

from . import configuration, opening, routes_catalog, routes_listener, routes_playback


def routes() -> dict:
    return {
        # the catalog
        "library": routes_catalog.summary,
        "tracks": routes_catalog.tracks,
        "albums": routes_catalog.albums,
        "artists": routes_catalog.artists,
        "genres": routes_catalog.genres,
        "folders": routes_catalog.folders,
        "duplicates": routes_catalog.duplicates,
        "search": routes_catalog.search,
        "artwork": routes_catalog.artwork,
        "lyrics": routes_catalog.lyrics,
        "scan": routes_catalog.scan,
        # the listener's own data
        "favorites": routes_listener.favorites,
        "pins": routes_listener.pins,
        "playlists": routes_listener.playlists,
        "covers": routes_listener.covers,
        "history": routes_listener.history,
        "stats": routes_listener.stats,
        "wrapped": routes_listener.wrapped,
        "preferences": routes_listener.preferences,
        "settings": routes_listener.settings,
        "home": routes_listener.home,
        "mixes": routes_listener.mixes,
        "radio": routes_listener.radio,
        "moods": routes_listener.moods,
        "recommendations": routes_listener.recommendations,
        # playing
        "stream": routes_playback.stream,
        "playback": routes_playback.playback,
        "queue": routes_playback.queue,
        "connect": routes_playback.connect,
        # files.open: another interface's "Opens with" plays a sound by its path
        "open": opening.open_file,
        # same convention as every other Satellite - see docs/satellites.md
        "configuration": configuration_route,
    }


def configuration_route(request):
    if request.method == "GET":
        return json_response(configuration.describe(request.satellite))

    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    body = request.body or {}
    key, value = body.get("key"), body.get("value")
    try:
        if "values" in body:
            # several settings from one form, all checked before any is saved
            return json_response(configuration.update_many(request.satellite, body.get("values")))
        if not isinstance(key, str):
            return error_response("'key' must be a string", status=400)
        return json_response(configuration.update(request.satellite, key, value))
    except configuration.ConfigurationError as error:
        return error_response(str(error), status=400)
