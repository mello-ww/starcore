"""A listener's own data: likes, pins, playlists, history, preferences, Home and mixes."""

from datetime import datetime, timedelta, timezone
import os
import secrets

from starcore.api.response import error_response, file_response

from .history import year_now
from .routing import identifier, ok, route

COVER_LIMIT = 4 * 1024 * 1024
IMPORT_LIMIT = 2 * 1024 * 1024
IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"))


@route("GET", "POST")
def favorites(call):
    music = call.music
    if call.method == "GET":
        return ok(music.collection.favorites(call.user))
    kind = call.body.get("kind", "track")
    items = call.body.get("ids", call.body.get("id"))
    return ok({"ids": music.collection.set_favorite(call.user, kind, items, bool(call.body.get("liked", True)))})


@route("GET", "POST")
def pins(call):
    music = call.music
    if call.method == "POST":
        music.collection.set_pin(call.user, call.body.get("kind", ""), str(call.body.get("id", "")),
                                 bool(call.body.get("pinned", True)))
    return ok({"pins": music.collection.pins(call.user)})


@route("GET", "POST")
def playlists(call):
    music = call.music
    store = music.playlists
    first = call.segment(0)

    if first is None:
        if call.method == "GET":
            return ok({"playlists": store.list(call.user)})
        body = call.body
        return ok(store.create(call.user, body.get("name"), body.get("description", ""), body.get("folder", ""),
                               body.get("visibility", "private"), body.get("rules"), body.get("tracks")), status=201)

    if first == "import" and call.method == "POST":
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
        playlist = store.get(call.user, playlist_id)
        if playlist is None:
            return error_response(f"unknown playlist '{playlist_id}'")
        return ok(playlist)

    body = call.body
    if action is None:
        updated = store.update(call.user, playlist_id, body)
        return ok(updated) if updated is not None else error_response(f"unknown playlist '{playlist_id}'")
    if action == "delete":
        if not store.delete(call.user, playlist_id):
            return error_response(f"unknown playlist '{playlist_id}'")
        return ok({"deleted": True})
    if action == "add":
        position = body.get("position")
        return ok(store.add(call.user, playlist_id, body.get("tracks"), bool(body.get("allow_duplicates")),
                            int(position) if isinstance(position, (int, float)) else None))
    if action == "remove":
        return ok(store.remove(call.user, playlist_id, body.get("entries")))
    if action == "move":
        return ok(store.move(call.user, playlist_id, str(body.get("entry", "")), int(body.get("to", 0))))
    if action == "reorder":
        return ok(store.reorder(call.user, playlist_id, body.get("entries")))
    if action == "cover":
        return _upload_cover(call, playlist_id)
    return error_response(f"unknown playlist action '{action}'")


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
    safe = "".join(char for char in name if char.isalnum() or char in " -_").strip() or "playlist"
    return file_response(target, "audio/x-mpegurl; charset=utf-8", download_name=f"{safe}.m3u8")


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
    return ok(payload)


@route("GET")
def wrapped(call):
    year = call.integer("year", year_now(), 1970, 9999)
    return ok(call.music.history.wrapped(call.user, year))


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
    return ok(music.discovery.home(call.user, int(hour) if str(hour or "").isdigit() else None, enabled))


@route("GET")
def mixes(call):
    music = call.music
    if not call.path:
        return ok({"mixes": music.discovery.mixes(call.user)})
    mix = music.discovery.mix(call.user, str(call.segment(0))[:80])
    return ok(mix) if mix is not None else error_response("unknown mix")


@route("GET")
def radio(call):
    kind = call.segment(0)
    item = "/".join(call.path[1:])
    if kind in ("track", "artist", "album"):
        item = identifier(item, kind)
    if not item:
        return error_response("radio needs a seed")
    station = call.music.discovery.radio(call.user, kind, item[:120], call.integer("size", 50, 5, 200))
    return ok(station) if station is not None else error_response("nothing to build a radio station from")


@route("GET")
def moods(call):
    music = call.music
    if not call.path:
        return ok({"moods": music.discovery.moods(music.discovery._signals(call.user))})
    mood = music.discovery.mood(call.user, str(call.segment(0))[:40])
    return ok(mood) if mood is not None else error_response("unknown mood")


@route("GET")
def recommendations(call):
    return ok({"tracks": call.music.discovery.recommended(call.user, call.integer("limit", 30, 1, 100))})
