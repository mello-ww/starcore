"""Browsing the library: tracks, albums, artists, genres, folders, search, artwork, lyrics, scans."""

import re
from pathlib import Path

from starcore.api.response import error_response, file_response

from . import lyrics as lyric_files
from . import opening, views
from .routing import identifier, ok, route

MOSAIC_ALBUMS = views.MOSAIC_ALBUMS
mosaic_key = views.mosaic_key

# a track is addressed by a digest of its content, so what comes back can be cached
IMMUTABLE = "private, max-age=604800"
ARTWORK_CACHE = "private, max-age=86400"


@route("GET")
def summary(call):
    """The library's totals; with `tab`, one tab of Your Library as the shared interface reads it."""
    if call.query.get("tab"):
        return ok(views.library(call))
    payload = call.music.summary()
    payload["transcoding"] = call.music.transcoder.available
    return ok(payload)


@route("GET", "POST")
def tracks(call):
    music = call.music
    if call.method == "POST":
        if call.segment(0) == "hide":
            ids = call.body.get("ids") if isinstance(call.body.get("ids"), list) else []
            return ok({"changed": music.set_hidden([value for value in ids if isinstance(value, str)][:5000],
                                                   bool(call.body.get("hidden", True)))})
        return error_response("only GET is supported here", status=405)

    if not call.path:
        query = call.query
        result = music.catalog.tracks(
            sort=query.get("sort"), order=query.get("order", "asc"),
            limit=call.integer("limit", 0, 0, 5000) or None, offset=call.integer("offset", 0, 0, 10_000_000),
            genre=query.get("genre"), quality=query.get("quality"), album_id=query.get("album"),
            artist_id=query.get("artist"), include_hidden=query.get("hidden") == "1", user=call.user)
        return ok(result)

    track_id = identifier(call.segment(0), "track")
    row = music.catalog.track_row(track_id)
    page = call.query.get("page") == "1"
    if page and row is not None and row["external"]:
        # a sound from outside the library: asked again, so the page shows whether it can still be played
        opening.refresh(music, call.request, [track_id])
    track = music.catalog.track(track_id)
    if track is None:
        return error_response(f"unknown track '{call.segment(0)}'")
    if page:
        # Show in folder: the file's path, only for a file this session may browse
        track["location"] = opening.location(call.request, row["path"])
        track["library_note"] = "Not in the library" if track["external"] else ""
    track["liked"] = music.collection.is_favorite(call.user, "track", track["id"])
    track["plays"] = music.history.play_counts(call.user).get(track["id"], 0)
    return ok(track)


@route("GET")
def albums(call):
    music = call.music
    if not call.path:
        query = call.query
        return ok({"albums": music.catalog.albums(
            sort=query.get("sort"), order=query.get("order", "asc"), limit=call.integer("limit", 0, 0, 5000) or None,
            offset=call.integer("offset", 0, 0, 10_000_000), release=query.get("type"), genre=query.get("genre"))})

    album = music.catalog.album(identifier(call.segment(0), "album"), user=call.user)
    if album is None:
        return error_response(f"unknown album '{call.segment(0)}'")
    album["liked"] = music.collection.is_favorite(call.user, "album", album["id"])
    album["not_liked"] = not album["liked"]
    liked = views.liked_tracks(music, call.user)
    for position, track in enumerate(album["tracks"]):
        views.decorate(track, liked, position)
        # a heading per disc, on an album that has more than one
        track["disc_label"] = f"Disc {track['disc'] or 1}" if album["discs"] > 1 else ""
    pinned = views.pinned_set(music, call.user)
    saved = set(music.collection.favorite_ids(call.user)["album"])
    album["more_by_artist"] = [views.flags(other, saved, pinned, "album")
                               for other in music.catalog.albums(artist_id=album["artist_id"])
                               if other["id"] != album["id"]][:12]
    album["line"] = " · ".join(part for part in (
        str(album["year"]) if album.get("year") else "", album["type"].title(), views.songs(len(album["tracks"])),
        views.length(album.get("duration")), views.badge(album.get("quality"))) if part)
    # what the player says it plays from, as Music's interface names it
    album["context"] = f"album:{album['id']}"
    return ok(album)


@route("GET")
def artists(call):
    music = call.music
    if not call.path:
        return ok({"artists": music.catalog.artists(sort=call.query.get("sort"),
                                                    include_featured=call.query.get("featured") == "1")})

    artist = music.catalog.artist(identifier(call.segment(0), "artist"), user=call.user)
    if artist is None:
        return error_response(f"unknown artist '{call.segment(0)}'")
    artist["followed"] = music.collection.is_favorite(call.user, "artist", artist["id"])
    artist["not_followed"] = not artist["followed"]
    liked = views.liked_tracks(music, call.user)
    for position, track in enumerate(artist["top_tracks"]):
        views.decorate(track, liked, position)
    pinned = views.pinned_set(music, call.user)
    saved = set(music.collection.favorite_ids(call.user)["album"])
    for key in ("albums", "singles", "appears_on"):
        artist[key] = [views.flags(album, saved, pinned, "album") for album in artist[key]]
    artist["context"] = f"artist:{artist['id']}"
    return ok(artist)


@route("GET")
def genres(call):
    """Every genre, or one by name (?name=): its tracks, its albums and a mosaic of their covers."""
    music = call.music
    name = call.query.get("name")
    if not name:
        listed = music.catalog.genres()
        for genre in listed:
            genre["context"] = genre_context(genre["name"])
        return ok({"genres": listed})
    name = str(name)[:120]
    tracks = music.catalog.tracks(genre=name, limit=500, user=call.user)
    albums = music.catalog.albums(genre=name)
    if not tracks.get("tracks") and not albums:
        return error_response(f"unknown genre '{name}'", status=404)
    covers = [album["id"] for album in albums if album.get("artwork")][:MOSAIC_ALBUMS]
    liked = views.liked_tracks(music, call.user)
    for position, track in enumerate(tracks.get("tracks", [])):
        views.decorate(track, liked, position)
    return ok({"name": name, "tracks": tracks.get("tracks", []), "total": tracks.get("total"), "albums": albums,
               "mosaic": covers, "mosaic_key": mosaic_key(covers), "context": genre_context(name)})


def genre_context(name: str) -> str:
    return "genre:" + re.sub(r"[^\w]+", "-", name.lower(), flags=re.ASCII)


@route("GET")
def folders(call):
    """Browse by folder: a source by position, then a path the index already holds."""
    music = call.music
    sources = [str(path) for path in music.source_paths()]
    indexed = [source for source in music.catalog.sources() if source not in sources]
    roots = sources + indexed
    if not call.path:
        return ok({"sources": [{"index": index, "name": Path(root).name or root, "configured": root in sources}
                               for index, root in enumerate(roots)]})
    try:
        index = int(call.segment(0))
    except ValueError:
        return error_response("unknown folder")
    # a path in the URL's own segments, or as `path=` (the shared interface's folder pages)
    parts = call.path[1:] if call.query.get("path") is None else str(call.query["path"]).split("/")
    folder = "/".join(part for part in parts if part)
    if ".." in parts or "\\" in folder:
        return error_response("unknown folder")
    listing = music.catalog.folder(index, folder, roots)
    if listing is None:
        return error_response("unknown folder")
    listing["name"] = Path(folder).name if folder else (Path(roots[index]).name or roots[index])
    listing["source_name"] = Path(roots[index]).name or roots[index]
    return ok(views.folder_view(listing, index, views.liked_tracks(music, call.user)))


@route("GET")
def duplicates(call):
    found = call.music.catalog.duplicates()
    if call.query.get("view") == "shared":
        return ok(views.duplicates(found, views.liked_tracks(call.music, call.user)))
    return ok(found)


@route("GET", "POST")
def search(call):
    music = call.music
    if call.segment(0) == "recent":
        if call.method == "POST":
            if call.body.get("clear"):
                music.collection.clear_searches(call.user)
            elif isinstance(call.body.get("query"), str):
                music.collection.remember_search(call.user, call.body["query"])
        recent = music.collection.recent_searches(call.user)
        return ok({"recent": recent, "has_recent": bool(recent)})
    if call.segment(0) == "suggest":
        return ok({"suggestions": music.finder.suggest(call.user, call.query.get("q", ""))})
    if call.method != "GET":
        return error_response("only GET is supported here", status=405)
    kinds = [kind for kind in call.query.get("type", "").split(",") if kind] or None
    result = music.finder.search(call.user, call.query.get("q", ""), kinds=kinds, genre=call.query.get("genre"),
                                 quality=call.query.get("quality"), limit=call.integer("limit", 20, 1, 100))
    if call.query.get("remember") == "1" and any(result[key] for key in ("tracks", "albums", "artists")):
        # a search field that searches as the person types remembers the query it settled on
        music.collection.remember_search(call.user, result["query"], replace_prefixes=True)
    return ok(views.search(music, call.user, result, views.liked_tracks(music, call.user)))


@route("GET")
def artwork(call):
    if not call.path:
        return error_response("no album was requested")

    music = call.music
    size = call.integer("size", 0, 0, 2000) or None
    if call.segment(0) == "mosaic":
        ids = [identifier(value, "album") for value in str(call.segment(1, "")).split(".")[:MOSAIC_ALBUMS]]
        found = {album["id"]: album for album in music.catalog.albums_by_id(ids)}
        path = music.mosaic_path([found[album_id] for album_id in ids if album_id in found], size)
        if path is None:
            return error_response("these albums have no cover art")
        return file_response(path, image_type(path), ARTWORK_CACHE)
    album_id = identifier(call.segment(0), "album")
    album = next(iter(music.catalog.albums_by_id([album_id])), None)
    if album is None:
        return error_response(f"unknown album '{album_id}'")

    path = music.artwork_path(album, size)
    if path is None:
        return error_response("this album has no cover art")
    return file_response(path, image_type(path), ARTWORK_CACHE)


@route("GET", "POST")
def lyrics(call):
    music = call.music
    track_id = identifier(call.segment(0), "track")
    row = music.catalog.track_row(track_id)
    if row is not None and row["external"]:
        opening.refresh(music, call.request, [track_id])
        row = music.catalog.track_row(track_id)
    if row is None or row["missing"]:
        return error_response(f"unknown track '{track_id}'")
    if call.method == "POST":
        offset = int(max(-30000, min(float(call.body.get("offset", 0)), 30000)))
        music.db.execute("INSERT INTO lyrics_offsets (user, track_id, offset_ms) VALUES (?, ?, ?) ON CONFLICT "
                         "(user, track_id) DO UPDATE SET offset_ms = excluded.offset_ms", (call.user, track_id, offset))
        return ok({"offset": offset})
    found = lyric_files.lyrics(Path(row["path"]), call.query.get("language"))
    if found is None:
        return error_response("no lyrics were found for this track")
    found["offset"] = music.db.value("SELECT offset_ms FROM lyrics_offsets WHERE user = ? AND track_id = ?",
                                     (call.user, track_id), 0)
    found.pop("metadata", None)
    return ok(found)


@route("GET", "POST")
def scan(call):
    music = call.music
    shared = call.query.get("view") == "shared"
    if call.method == "GET":
        return ok(views.scan(music.scan_status()) if shared else music.scan_status())
    if call.body.get("cancel"):
        music.cancel_scan()
        return ok(views.scan(music.scan_status()) if shared else music.scan_status())
    source = call.body.get("source")
    if source is not None and not isinstance(source, str):
        return error_response("'source' must be a path to a directory on this machine", status=400)
    if call.body.get("background"):
        return ok(music.scan_in_background(source))
    return ok(music.scan(source))


def image_type(path: Path) -> str:
    return {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
