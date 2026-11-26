"""A listener's own data: likes, pins, playlists, history, preferences, Home and mixes."""

from datetime import datetime, timedelta, timezone
import os
import secrets

from starcore.api.response import error_response, file_response, json_response

from . import configuration, views
from .history import year_now
from .playlists import parse_m3u
from .routes_catalog import image_type, mosaic_key
from .routing import identifier, ok, route

COVER_LIMIT = 4 * 1024 * 1024
IMPORT_LIMIT = 2 * 1024 * 1024
# a playlist's picture changes with its cover and its songs: its URL carries ?v=<updated_at>
PICTURE_CACHE = "private, max-age=86400"
IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"))


@route("GET", "POST")
def favorites(call):
    music = call.music
    if call.method == "GET":
        return ok(music.collection.favorites(call.user))
    kind = call.body.get("kind", "track")
    items = call.body.get("ids", call.body.get("id"))
    liked = bool(call.body.get("liked", True))
    answer = {"ids": music.collection.set_favorite(call.user, kind, items, liked)}
    if isinstance(items, str):
        # one row's heart, which the shared interface turns over in place (`then: "update"`)
        answer["item"] = {"liked": liked, "not_liked": not liked}
    return ok(answer)


@route("GET", "POST")
def pins(call):
    music = call.music
    if call.method == "POST":
        pinned = bool(call.body.get("pinned", True))
        music.collection.set_pin(call.user, call.body.get("kind", ""), str(call.body.get("id", "")), pinned)
        return ok({"pins": music.collection.pins(call.user), "item": {"pinned": pinned, "not_pinned": not pinned}})
    return ok({"pins": music.collection.pins(call.user)})


@route("GET", "POST")
def playlists(call):
    music = call.music
    store = music.playlists
    first = call.segment(0)

    if first is None:
        if call.method == "GET":
            rows = store.list(call.user)
            if call.query.get("editable"):
                # the playlists a song can be added to, as the "Add to playlist" dialog lists them
                rows = [row for row in rows if not row["smart"]]
                for row in rows:
                    row["line"] = views.songs(row.get("tracks") or 0)
            return ok({"playlists": rows})
        body = call.body
        # a smart playlist as a form sends it: its rows of rules, then match, sort, order and limit
        rules = _form_rules(body) if body.get("smart") else body.get("rules")
        created = store.create(call.user, body.get("name"), body.get("description", ""), body.get("folder", ""),
                               body.get("visibility", "private"), rules, body.get("tracks"))
        return ok({**created, "message": f"Created {created['name']}."}, status=201)

    if first == "import" and call.method == "POST":
        if call.request.raw is not None:
            return _import_file(call)
        content = call.body.get("content")
        if isinstance(content, str):
            if len(content.encode("utf-8")) > IMPORT_LIMIT:
                return error_response("the playlist file is too large", status=413)
            return ok(store.import_m3u(call.user, call.body.get("name"), content))
        return ok(store.import_entries(call.user, call.body.get("name") or "Imported playlist",
                                       call.body.get("entries"), call.body.get("description", "")))
    if first == "preview" and call.method == "POST":
        return ok({"tracks": store.preview(call.user, call.body.get("rules"))})

    playlist_id = identifier(first, "playlist")
    action = call.segment(1)

    if call.method == "GET":
        if action == "export":
            return _export(call, playlist_id)
        if action == "picture":
            return _picture(call, playlist_id)
        playlist = store.get(call.user, playlist_id)
        if playlist is None:
            return error_response(f"unknown playlist '{playlist_id}'")
        liked = views.liked_tracks(music, call.user)
        for position, entry in enumerate(playlist["tracks"]):
            views.decorate(entry, liked, position)
        playlist["pinned"] = ("playlist", playlist_id) in views.pinned_set(music, call.user)
        playlist["not_pinned"] = not playlist["pinned"]
        playlist["mosaic_key"] = mosaic_key(playlist.get("mosaic") or [])
        playlist["line"] = " · ".join(part for part in (
            views.songs(playlist["track_count"] - playlist["unavailable"]), views.length(playlist["duration"]),
            f"{playlist['unavailable']} unavailable" if playlist["unavailable"] else "") if part)
        # what the player says it plays from, as Music's own page names it
        playlist["context"] = f"playlist:{playlist_id}"
        playlist["regular"] = not playlist["smart"]
        playlist["has_unmatched"] = bool(playlist["unmatched"])
        missing = len(playlist["unmatched"])
        playlist["unmatched_line"] = (f"{views.songs(missing)} from the imported file {'is' if missing == 1 else 'are'}"
                                      f" not in your library." if missing else "")
        for entry in playlist["unmatched"]:
            entry["line"] = " · ".join(part for part in (entry.get("artist"), entry.get("album")) if part)
            entry["title"] = entry.get("title") or entry.get("path") or "Unknown song"
        playlist["export_name"] = f"{_safe_name(playlist['name'])}.m3u8"
        playlist.update(_rules_form(playlist["rules"]))
        return ok(playlist)

    body = call.body
    if action is None:
        changes = dict(body)
        if changes.pop("smart", None):
            changes["rules"] = _form_rules(body)
        for key in ("conditions", "match", "sort", "order", "limit"):
            changes.pop(key, None)
        updated = store.update(call.user, playlist_id, changes)
        if updated is None:
            return error_response(f"unknown playlist '{playlist_id}'")
        return ok({**updated, "message": "Saved."})
    if action == "delete":
        if not store.delete(call.user, playlist_id):
            return error_response(f"unknown playlist '{playlist_id}'")
        return ok({"deleted": True, "message": "Playlist deleted."})
    if action == "add":
        position = body.get("position")
        allow = bool(body.get("allow_duplicates"))
        if body.get("ask") and not allow:
            # the shared "Add to playlist" dialog: a song already there is asked about first
            return _add_asking(call, playlist_id, body.get("tracks"))
        added = store.add(call.user, playlist_id, body.get("tracks"), allow,
                          int(position) if isinstance(position, (int, float)) else None)
        return ok({**added, "message": f"Added to {added['playlist']['name']}."})
    if action == "dismiss":
        dismissed = store.dismiss(call.user, playlist_id)
        return ok(dismissed) if dismissed is not None else error_response(f"unknown playlist '{playlist_id}'")
    if action == "remove":
        return ok(store.remove(call.user, playlist_id, body.get("entries")))
    if action == "move":
        return ok(store.move(call.user, playlist_id, str(body.get("entry", "")), int(body.get("to", 0))))
    if action == "reorder":
        return ok(store.reorder(call.user, playlist_id, body.get("entries")))
    if action == "cover":
        return _upload_cover(call, playlist_id)
    return error_response(f"unknown playlist action '{action}'")


def _form_rules(body: dict) -> dict:
    """A smart playlist's rules from a form: `conditions` rows of {field, op, value}, then match,
    sort, order and limit as the form's own fields. validate_rules checks every value."""
    conditions = body.get("conditions")
    if not isinstance(conditions, list):
        conditions = []
    return {"rules": [{"field": row.get("field"), "op": row.get("op"), "value": row.get("value")}
                      for row in conditions if isinstance(row, dict)],
            "match": body.get("match"), "sort": body.get("sort") or "added", "order": body.get("order"),
            "limit": body.get("limit") or 500}


def _rules_form(rules) -> dict:
    """A smart playlist's rules as its edit form starts: the rows, and match, sort, order and limit."""
    if not rules:
        return {"conditions": [], "match": "all", "sort": "added", "order": "desc", "limit": 500}
    rows = []
    for rule in rules.get("rules") or []:
        value = rule.get("value")
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, list):
            value = " - ".join(_number_text(item) for item in value)
        elif isinstance(value, float):
            value = _number_text(value)
        rows.append({"field": rule.get("field"), "op": rule.get("op"),
                     "value": "" if value is None else str(value)})
    return {"conditions": rows, "match": rules.get("match", "all"), "sort": rules.get("sort", "added"),
            "order": rules.get("order", "desc"), "limit": rules.get("limit", 500)}


def _number_text(value) -> str:
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def _add_asking(call, playlist_id: str, tracks):
    """Adds songs unless one is already in the playlist: then a 409 that names it, and nothing is
    added until the listener says to add it anyway (`allow_duplicates`)."""
    store = call.music.playlists
    playlist = store.get(call.user, playlist_id)
    if playlist is None:
        return error_response(f"unknown playlist '{playlist_id}'")
    if playlist["smart"]:
        return error_response("a smart playlist is filled by its rules", status=400)
    present = {entry.get("id") for entry in playlist["tracks"]}
    wanted = [track for track in tracks if isinstance(track, str)] if isinstance(tracks, list) else []
    duplicates = [track for track in wanted if track in present]
    if duplicates:
        text = (f"This song is already in {playlist['name']}." if len(wanted) == 1
                else f"Some of these songs are already in {playlist['name']}.")
        return json_response({"error": text, "message": text, "duplicates": duplicates}, status=409)
    added = store.add(call.user, playlist_id, wanted)
    return ok({**added, "message": f"Added to {playlist['name']}."})


def _import_file(call):
    """A playlist file sent as the raw body (the shared interface's upload). ?name= is the file's
    own name, used when the file names no playlist itself."""
    raw = call.request.raw
    if raw.length > IMPORT_LIMIT:
        return error_response("the playlist file is too large", status=413)
    data = b"".join(raw)
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = data.decode("latin-1")
    entries = parse_m3u(content)
    stem = str(call.query.get("name") or "").rsplit(".", 1)[0].strip()
    name = next((entry["playlist"] for entry in entries if entry.get("playlist")), None) or stem or "Imported playlist"
    result = call.music.playlists.import_entries(call.user, name, entries)
    missing = len(result["unmatched"])
    message = f"Imported {result['playlist']['name']}: {views.songs(result['matched'])}" + (
        f", {missing} not found." if missing else ".")
    return ok({**result, "message": message})


def _picture(call, playlist_id: str):
    """A playlist's picture: its uploaded cover, the album cover it was given, or else a mosaic
    of its first albums' covers."""
    music = call.music
    row = music.db.one("SELECT cover FROM playlists WHERE id = ? AND owner = ?", (playlist_id, call.user))
    if row is None:
        return error_response(f"unknown playlist '{playlist_id}'")
    size = call.integer("size", 0, 0, 2000) or None
    cover = row["cover"] or ""
    if cover.startswith("upload:"):
        upload = cover.split(":", 1)[1]
        path = next((candidate for candidate in music.covers_dir.glob(f"{upload}.*")
                     if candidate.suffix != ".part"), None)
        if path is not None:
            return file_response(path, "image/png" if path.suffix == ".png" else "image/jpeg", PICTURE_CACHE)
    if cover.startswith("album:"):
        album = next(iter(music.catalog.albums_by_id([cover.split(":", 1)[1]])), None)
        path = music.artwork_path(album, size) if album else None
        if path is not None:
            return file_response(path, image_type(path), PICTURE_CACHE)
    ids = (music.playlists.get(call.user, playlist_id) or {}).get("mosaic") or []
    found = {album["id"]: album for album in music.catalog.albums_by_id(ids)}
    path = music.mosaic_path([found[album_id] for album_id in ids if album_id in found], size)
    if path is None:
        return error_response("this playlist has no picture")
    return file_response(path, image_type(path), PICTURE_CACHE)


def _safe_name(name: str) -> str:
    return "".join(char for char in name if char.isalnum() or char in " -_").strip() or "playlist"


def _export(call, playlist_id: str):
    music = call.music
    text = music.playlists.export_m3u(call.user, playlist_id)
    if text is None:
        return error_response(f"unknown playlist '{playlist_id}'")
    name = music.playlists.get(call.user, playlist_id)["name"]
    directory = music.cache_dir / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{playlist_id}-{secrets.token_hex(4)}.m3u8"
    target.write_text(text, encoding="utf-8")
    for stale in sorted(directory.glob("*.m3u8"), key=lambda path: path.stat().st_mtime)[:-20]:
        stale.unlink(missing_ok=True)
    return file_response(target, "audio/x-mpegurl; charset=utf-8", download_name=f"{_safe_name(name)}.m3u8")


def _upload_cover(call, playlist_id: str):
    music = call.music
    if music.playlists.get(call.user, playlist_id) is None:
        return error_response(f"unknown playlist '{playlist_id}'")
    raw = call.request.raw
    if raw is None:
        album = call.body.get("album")
        cover = f"album:{identifier(album, 'album')}" if album else None
        return ok(music.playlists.update(call.user, playlist_id, {"cover": cover}))
    if raw.length > COVER_LIMIT:
        return error_response("a cover image may be at most 4 MB", status=413)
    data = b"".join(raw)
    extension = next((ext for magic, ext in IMAGE_MAGIC if data.startswith(magic)), None)
    if extension is None:
        return error_response("a cover must be a PNG or JPEG image", status=415)
    upload = secrets.token_hex(8)
    music.covers_dir.mkdir(parents=True, exist_ok=True)
    partial = music.covers_dir / f".{upload}.part"
    partial.write_bytes(data)
    os.replace(partial, music.covers_dir / f"{upload}.{extension}")
    return ok(music.playlists.update(call.user, playlist_id, {"cover": f"upload:{upload}"}))


@route("GET")
def covers(call):
    music = call.music
    upload = identifier(call.segment(0), "cover")
    owned = music.db.one("SELECT 1 FROM playlists WHERE owner = ? AND cover = ?", (call.user, f"upload:{upload}"))
    path = next((candidate for candidate in music.covers_dir.glob(f"{upload}.*") if candidate.suffix != ".part"), None)
    if not owned or path is None:
        return error_response("unknown cover")
    return file_response(path, "image/png" if path.suffix == ".png" else "image/jpeg", "private, max-age=86400")


@route("GET", "POST")
def history(call):
    music = call.music
    if call.method == "GET":
        return ok({"tracks": music.history.recent(call.user, call.integer("limit", 50, 1, 500)),
                   "enabled": music.preferences.get(call.user, "history_enabled")})
    if call.segment(0) == "clear":
        before = call.body.get("before")
        return ok({"removed": music.history.clear(call.user, before if isinstance(before, str) else None)})
    if not music.preferences.get(call.user, "history_enabled"):
        return ok({"counted": False, "recorded": False})
    track_id = identifier(call.body.get("track_id"), "track")
    result = music.history.record(call.user, track_id, call.body.get("seconds", 0), call.body.get("device"),
                                  call.body.get("context"))
    return ok({**result, "recorded": True})


@route("GET")
def stats(call):
    days = call.integer("days", 30, 0, 36500)
    start = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds") if days else None
    payload = call.music.history.stats(call.user, start, limit=call.integer("limit", 10, 1, 50))
    payload["library"] = call.music.summary()
    if call.query.get("view") == "shared":
        return ok(views.stats(call.music, call.user, payload, days, year_now()))
    return ok(payload)


@route("GET")
def wrapped(call):
    year = call.integer("year", year_now(), 1970, 9999)
    payload = call.music.history.wrapped(call.user, year)
    if call.query.get("view") == "shared":
        first = call.music.history.first_year(call.user)
        return ok(views.wrapped(call.music, call.user, payload, year_now(), first))
    return ok(payload)


@route("GET", "POST")
def settings(call):
    """Music's Settings page as the shared interface reads it; a POST changes preferences (the
    accent as a mode and a colour) and answers the page again."""
    music = call.music
    if call.method == "POST":
        music.preferences.update(call.user, views.accent_change(call.body))
    request = call.request
    config = {key: configuration.value_of(request.satellite, key) for key in configuration.SETTINGS}
    return ok(views.settings(music, call.user, call.session, config, music.transcoder.available))


@route("GET", "POST")
def preferences(call):
    music = call.music
    if call.method == "POST":
        return ok(music.preferences.update(call.user, call.body))
    return ok(music.preferences.all(call.user))


@route("GET")
def home(call):
    music = call.music
    hour = call.query.get("hour")
    enabled = bool(music.preferences.get(call.user, "discovery_enabled"))
    answer = music.discovery.home(call.user, int(hour) if str(hour or "").isdigit() else None, enabled)
    if call.query.get("view") == "shelves":
        # each section under its own key, for the shared interface
        return ok(views.home(music, call.user, answer))
    return ok(answer)


@route("GET")
def mixes(call):
    music = call.music
    if not call.path:
        listed = music.discovery.mixes(call.user)
        for mix in listed:
            mix["mosaic_key"] = mosaic_key(mix.get("mosaic") or [])
        return ok({"mixes": listed})
    mix_id = str(call.segment(0))[:80]
    if mix_id.startswith("mood-"):
        # a mood opens as a mix too, so a shelf of both opens each the same way
        mood = _mood(call, mix_id[5:45])
        if mood is None:
            return error_response("unknown mix")
        mood["id"] = mix_id
        mood["description"] = ", ".join(mood.get("genres", [])[:3])
        return ok(mood)
    mix = music.discovery.mix(call.user, mix_id)
    if mix is None:
        return error_response("unknown mix")
    # what the player says it plays from, and the mix's picture, as Music's own page names them
    mix["context"] = f"mix:{mix['id']}"
    mix["mosaic_key"] = mosaic_key(mix.get("mosaic") or [])
    liked = views.liked_tracks(music, call.user)
    for position, track in enumerate(mix["tracks"]):
        views.decorate(track, liked, position)
    return ok(mix)


@route("GET")
def radio(call):
    kind = call.segment(0)
    item = "/".join(call.path[1:])
    if kind in ("track", "artist", "album"):
        item = identifier(item, kind)
    if not item:
        return error_response("radio needs a seed")
    station = call.music.discovery.radio(call.user, kind, item[:120], call.integer("size", 50, 5, 200))
    if station is None:
        return error_response("nothing to build a radio station from")
    station["context"] = f"radio:{kind}-{item[:120]}"[:80]
    liked = views.liked_tracks(call.music, call.user)
    for position, track in enumerate(station["tracks"]):
        views.decorate(track, liked, position)
    return ok(station)


@route("GET")
def moods(call):
    music = call.music
    if not call.path:
        return ok({"moods": music.discovery.moods(music.discovery._signals(call.user))})
    mood = _mood(call, str(call.segment(0))[:40])
    return ok(mood) if mood is not None else error_response("unknown mood")


def _mood(call, mood_id: str):
    """A mood's tracks as rows, its picture and what the player says it plays from."""
    mood = call.music.discovery.mood(call.user, mood_id)
    if mood is None:
        return None
    mood["context"] = f"mix:mood-{mood['id']}"
    covers = list(dict.fromkeys(track["album_id"] for track in mood["tracks"]
                                if track.get("album_id") and track.get("has_artwork")))
    mood["mosaic"] = covers[:4]
    mood["mosaic_key"] = mosaic_key(covers)
    liked = views.liked_tracks(call.music, call.user)
    for position, track in enumerate(mood["tracks"]):
        views.decorate(track, liked, position)
    return mood


@route("GET")
def recommendations(call):
    return ok({"tracks": call.music.discovery.recommended(call.user, call.integer("limit", 30, 1, 100))})
