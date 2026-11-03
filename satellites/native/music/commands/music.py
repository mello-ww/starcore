"""music - the library, a listener's likes and playlists, and StarCore Connect playback.

Every command goes through the services the Music routes use (MusicLibrary,
Catalog, Collection, Playlists, Connect); nothing here touches the database
directly. Playback only relays the commands Connect already supports, to a
device that is online and accepts remote control.
"""

from datetime import datetime, timezone
import re
import time

from starcore.cli.runner import table
from starcore.cli.spec import (Argument, Command, CommandError, CommandTimeout, NotFound, Option, Result,
                               Unavailable, UsageError, bounded)

from ..collection import CollectionError
from ..connect import ConnectError
from ..library import MusicScanError, library_for, readable_duration, readable_size
from ..playlists import PlaylistError
from ..users import LOCAL_LISTENER

NAMESPACE = "music"
SUMMARY = "Music library, likes, playlists and StarCore Connect playback"
DEFAULT = "stats"

READ = "music.read"
CONTROL = "music.control"
MANAGE = "music.manage"

LIST_LIMIT = 10
WAIT_LIMIT = 30
IDENTIFIER = re.compile(r"^[0-9a-f]{8,64}$")
LIKE_KINDS = ("track", "album", "artist")


# ---------- shared ----------

def _music(ctx):
    music = library_for(ctx.engine)
    if music is None:
        raise Unavailable("the Music satellite is not loaded")
    return music


def _listener(ctx) -> str:
    # the same account the Music routes use: the signed-in user, or the one
    # local listener of a StarCore that has no account yet (see users.py)
    return ctx.user or LOCAL_LISTENER


def identifier(raw: str) -> str:
    value = raw.strip().lower()
    if not IDENTIFIER.match(value):
        raise ValueError(f"'{raw}' is not an identifier (8 to 64 hexadecimal characters)")
    return value


identifier.__name__ = "id"


def _track(entry: dict) -> dict:
    return {key: entry.get(key) for key in ("id", "title", "artist", "album", "track", "disc", "year",
                                            "duration", "format")}


# ---------- library ----------

def stats(ctx):
    return _music(ctx).summary()


def _render_stats(summary: dict) -> str:
    return "\n".join([
        "StarCore music library",
        "",
        f"Tracks       {summary['tracks']}",
        f"Albums       {summary['albums']}",
        f"Artists      {summary['artists']}",
        f"Duration     {readable_duration(summary['duration'])}",
        f"Size         {readable_size(summary['size_bytes'])}",
        f"Lossless     {summary['lossless']}",
        f"Missing      {summary['missing']}",
        f"Source       {summary['source']}",
        f"Last scan    {summary['last_scan'] or 'never'}",
    ])


def scan(ctx, directory, background):
    music = _music(ctx)
    # a path with spaces may arrive unquoted, in pieces - joined as before
    source = " ".join(directory) if directory else None
    try:
        if background:
            return Result(music.scan_in_background(source), "Scan started. Follow it with 'music scan-status'.")
        return music.scan(source)
    except MusicScanError as error:
        raise CommandError(str(error))


def _render_scan(result: dict) -> str:
    sources = result["source"] if isinstance(result["source"], list) else [result["source"]]
    lines = [f"Scanned {', '.join(sources)}", ""]
    for label, key in (("Found", "found"), ("Added", "added"), ("Updated", "updated"), ("Moved", "moved"),
                       ("Unchanged", "unchanged"), ("Restored", "restored"), ("Duplicates", "duplicates"),
                       ("Skipped", "skipped"), ("Missing", "removed")):
        lines.append(f"{label:<12} {result[key]}")
    lines.append(f"{'Failed':<12} {len(result['failed'])}")
    lines += [f"- {failure['file']}: {failure['reason']}" for failure in result["failed"]]
    return "\n".join(lines)


def scan_status(ctx):
    status = _music(ctx).scan_status()
    return {"running": status["running"], "progress": status["progress"], "error": status["error"],
            "last_scan": status["last_scan"]}


def tracks(ctx, count, offset):
    page = _music(ctx).catalog.tracks(limit=count, offset=offset)
    return {"total": page["total"], "offset": page["offset"], "tracks": [_track(entry) for entry in page["tracks"]]}


def _render_tracks(data: dict) -> str:
    if not data["total"]:
        return "The music library is empty. Run 'music scan' to index it."
    lines = [f"{data['total']} track(s), showing {len(data['tracks'])}", ""]
    for entry in data["tracks"]:
        lines.append(f"{entry['track'] or '-':>3}  {readable_duration(entry['duration']):>6}  "
                     f"{(entry['artist'] or '-')[:24]:<24}  {(entry['album'] or '-')[:24]:<24}  "
                     f"{entry['title']}  [{entry['id']}]")
    return "\n".join(lines)


def albums(ctx, count, offset):
    catalog = _music(ctx).catalog
    known = catalog.albums(limit=count, offset=offset)
    return {"total": catalog.album_count(), "albums": [
        {key: album[key] for key in ("id", "album", "artist", "year", "tracks", "duration", "type")}
        for album in known]}


def _render_albums(data: dict) -> str:
    if not data["total"]:
        return "The music library is empty. Run 'music scan' to index it."
    lines = [f"{data['total']} album(s), showing {len(data['albums'])}", ""]
    for album in data["albums"]:
        lines.append(f"{album['year'] or '----'}  {album['tracks']:>3} tracks  "
                     f"{readable_duration(album['duration']):>6}  {(album['artist'] or '-')[:28]:<28}  "
                     f"{album['album']}  [{album['id']}]")
    return "\n".join(lines)


def artists(ctx, count, offset):
    known = _music(ctx).catalog.artists()
    return {"total": len(known), "artists": [{key: artist[key] for key in ("id", "name", "albums", "tracks")}
                                             for artist in known[offset:offset + count]]}


def _render_artists(data: dict) -> str:
    if not data["total"]:
        return "The music library is empty. Run 'music scan' to index it."
    return f"{data['total']} artist(s), showing {len(data['artists'])}\n\n" + table(
        data["artists"], [("name", "Artist"), ("albums", "Albums"), ("tracks", "Tracks"), ("id", "Id")])


# ---------- likes ----------

def likes(ctx, kind):
    music = _music(ctx)
    favorites = music.collection.favorites(_listener(ctx))
    if kind == "track":
        items = [_track(entry) for entry in favorites["tracks"]]
    elif kind == "album":
        items = [{key: album[key] for key in ("id", "album", "artist", "year")} for album in favorites["albums"]]
    else:
        items = [{key: artist[key] for key in ("id", "name")} for artist in favorites["artists"]]
    return {"kind": kind, "count": len(items), "items": items}


def _render_likes(data: dict) -> str:
    if not data["count"]:
        return f"No liked {data['kind']}s yet."
    columns = {"track": [("title", "Title"), ("artist", "Artist"), ("album", "Album"), ("id", "Id")],
               "album": [("album", "Album"), ("artist", "Artist"), ("year", "Year"), ("id", "Id")],
               "artist": [("name", "Artist"), ("id", "Id")]}[data["kind"]]
    return f"{data['count']} liked {data['kind']}(s)\n\n" + table(data["items"], columns)


def _set_like(ctx, ids, kind, liked: bool):
    music = _music(ctx)
    lookup = {"track": music.catalog.track, "album": music.catalog.album, "artist": music.catalog.artist}[kind]
    for item_id in ids:
        if lookup(item_id) is None:
            raise NotFound(f"unknown {kind} '{item_id}'")
    try:
        music.collection.set_favorite(_listener(ctx), kind, list(ids), liked)
    except CollectionError as error:
        raise CommandError(str(error))
    return {"kind": kind, "ids": list(ids), "liked": liked}


def _render_like(data: dict) -> str:
    verb = "Liked" if data["liked"] else "Removed the like from"
    return f"{verb} {len(data['ids'])} {data['kind']}(s)."


# ---------- playlists ----------

def _playlist(ctx, music, reference: str) -> dict:
    """A playlist by id, or by its exact name (any letter case)."""
    user = _listener(ctx)
    if IDENTIFIER.match(reference.lower()):
        found = music.playlists.get(user, reference.lower())
        if found is not None:
            return found
    matches = [item for item in music.playlists.list(user) if item["name"].casefold() == reference.casefold()]
    if len(matches) > 1:
        raise UsageError(f"more than one playlist is called '{reference}' - use its id: "
                         + ", ".join(item["id"] for item in matches))
    if not matches:
        raise NotFound(f"unknown playlist '{reference}'")
    return music.playlists.get(user, matches[0]["id"])


def playlists(ctx):
    found = _music(ctx).playlists.list(_listener(ctx))
    return {"playlists": [{key: item.get(key) for key in ("id", "name", "smart", "tracks", "duration", "updated_at")}
                          for item in found]}


def _render_playlists(data: dict) -> str:
    if not data["playlists"]:
        return "No playlists yet. Create one with 'music playlist-create <name>'."
    rows = [{**item, "duration": readable_duration(item["duration"]), "smart": "smart" if item["smart"] else ""}
            for item in data["playlists"]]
    return table(rows, [("name", "Playlist"), ("tracks", "Tracks"), ("duration", "Length"), ("smart", ""),
                        ("id", "Id")])


def playlist(ctx, playlist):
    found = _playlist(ctx, _music(ctx), playlist)
    return {"id": found["id"], "name": found["name"], "description": found["description"], "smart": found["smart"],
            "track_count": found["track_count"], "duration": found["duration"],
            "tracks": [{"entry_id": entry.get("entry_id"), **_track(entry), "missing": bool(entry.get("missing"))}
                       for entry in found["tracks"]]}


def _render_playlist(data: dict) -> str:
    lines = [f"{data['name']}  ({data['track_count']} tracks, {readable_duration(data['duration'])})"]
    if data["description"]:
        lines.append(data["description"])
    lines.append("")
    for position, entry in enumerate(data["tracks"], 1):
        title = "(unavailable)" if entry["missing"] else entry["title"]
        lines.append(f"{position:>3}  {(entry['artist'] or '-')[:24]:<24}  {title}  "
                     f"[entry {entry['entry_id'] or '-'}]")
    return "\n".join(lines)


def playlist_create(ctx, name, description):
    try:
        created = _music(ctx).playlists.create(_listener(ctx), " ".join(name), description or "")
    except PlaylistError as error:
        raise CommandError(str(error))
    return {"id": created["id"], "name": created["name"]}


def playlist_add(ctx, playlist, tracks, allow_duplicates):
    music = _music(ctx)
    found = _playlist(ctx, music, playlist)
    for track_id in tracks:
        if music.catalog.track(track_id) is None:
            raise NotFound(f"unknown track '{track_id}'")
    try:
        updated = music.playlists.add(_listener(ctx), found["id"], list(tracks), allow_duplicates)
    except PlaylistError as error:
        raise CommandError(str(error))
    return {"id": found["id"], "name": found["name"], "track_count": updated.get("track_count")}


def playlist_remove(ctx, playlist, entries):
    music = _music(ctx)
    found = _playlist(ctx, music, playlist)
    known = {entry.get("entry_id") for entry in found["tracks"]}
    for entry in entries:
        if entry not in known:
            raise NotFound(f"'{found['name']}' has no entry '{entry}' - see 'music playlist {found['id']}'")
    try:
        updated = music.playlists.remove(_listener(ctx), found["id"], list(entries))
    except PlaylistError as error:
        raise CommandError(str(error))
    return {"id": found["id"], "name": found["name"], "track_count": updated.get("track_count")}


def playlist_delete(ctx, playlist):
    music = _music(ctx)
    found = _playlist(ctx, music, playlist)
    if not music.playlists.delete(_listener(ctx), found["id"]):
        raise NotFound(f"unknown playlist '{playlist}'")
    return {"id": found["id"], "name": found["name"], "deleted": True}


# ---------- StarCore Connect ----------

def _device(ctx, music, reference):
    """A device by id, exact name or unique name prefix; the active one when none is named."""
    user = _listener(ctx)
    devices = music.connect.devices(user)
    if not devices:
        raise Unavailable("no StarCore Connect devices are registered - open Music on a phone or browser first")

    if reference is None:
        active = music.connect.active(user)
        if active is not None:
            match = next((device for device in devices if device["id"] == active["device"]), None)
            if match is not None:
                return match
        online = [device for device in devices if device["online"]]
        if len(online) == 1:
            return online[0]
        raise UsageError("no device is playing - choose one with --device (see 'music devices')")

    reference = reference.strip()
    if not reference:
        raise UsageError("--device needs a device id or name (see 'music devices')")
    wanted = reference.casefold()
    for test in (lambda device: device["id"] == reference,
                 lambda device: device["name"].casefold() == wanted):
        matches = [device for device in devices if test(device)]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            break
    else:
        matches = [device for device in devices if device["name"].casefold().startswith(wanted)
                   or device["id"].startswith(reference)]
        if len(matches) == 1:
            return matches[0]
    if matches:
        raise UsageError(f"'{reference}' matches more than one device - use its id: "
                         + ", ".join(f"{device['name']} ({device['id']})" for device in matches))
    raise NotFound(f"unknown device '{reference}' - see 'music devices'")


def devices(ctx):
    music = _music(ctx)
    found = music.connect.devices(_listener(ctx))
    active = music.connect.active(_listener(ctx))
    return {"active": active["device"] if active else None, "devices": [{
        "id": device["id"], "name": device["name"], "kind": device["kind"], "online": device["online"],
        "playing": device["playing"], "remote_control": bool(device["capabilities"].get("remote")),
        "last_seen": _when(device["last_seen"]),
    } for device in found]}


def _when(stamp):
    return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat(timespec="seconds") if stamp else None


def _render_devices(data: dict) -> str:
    if not data["devices"]:
        return "No StarCore Connect devices are registered yet."
    rows = [{**device, "state": ("playing" if device["playing"] else "online") if device["online"] else "offline",
             "remote_control": "yes" if device["remote_control"] else "no",
             "name": f"{device['name']}{' *' if device['id'] == data['active'] else ''}"} for device in data["devices"]]
    return table(rows, [("name", "Device"), ("kind", "Kind"), ("state", "State"), ("remote_control", "Remote"),
                        ("id", "Id")]) + "\n\n* active device"


def playback(ctx, device):
    music = _music(ctx)
    target = _device(ctx, music, device)
    state = music.connect.state(_listener(ctx), target["id"]) or {}
    position = float(state.get("position") or 0)
    if state.get("playing") and target["online"] and state.get("updated_at"):
        position += max(0.0, time.time() - state["updated_at"]) * float(state.get("speed") or 1)
    duration = float(state.get("duration") or 0)
    track = music.catalog.track(state["track_id"]) if state.get("track_id") else None
    return {
        "device": {"id": target["id"], "name": target["name"], "online": target["online"]},
        "playing": bool(state.get("playing")) and target["online"],
        "track": _track(track) if track else None,
        "position": round(min(position, duration) if duration else position, 1),
        "duration": duration,
        "volume": state.get("volume"),
        "shuffle": bool(state.get("shuffle")),
        "repeat": state.get("repeat", "off"),
        "queue_length": len(state.get("queue") or []),
        "updated_at": _when(state.get("updated_at")),
    }


def _render_playback(data: dict) -> str:
    device = data["device"]
    head = f"{device['name']}{'' if device['online'] else ' (offline)'}"
    if data["track"] is None:
        return f"{head}: nothing queued."
    track = data["track"]
    state = "Playing" if data["playing"] else "Paused"
    return "\n".join([
        f"{head}: {state}",
        f"  {track['title']} - {track['artist'] or 'Unknown artist'}",
        f"  {_clock(data['position'])} / {_clock(data['duration'])}   volume {round((data['volume'] or 0) * 100)}%"
        f"   shuffle {'on' if data['shuffle'] else 'off'}   repeat {data['repeat']}   queue {data['queue_length']}",
    ])


def _clock(seconds) -> str:
    seconds = int(seconds or 0)
    hours, rest = divmod(seconds, 3600)
    return (f"{hours}:" if hours else "") + f"{rest // 60:0{2 if hours else 1}}:{rest % 60:02}"


def _send(ctx, device, command: str, arguments: dict, wait: int):
    music = _music(ctx)
    target = _device(ctx, music, device)
    name = target["name"]
    if not target["online"]:
        raise Unavailable(f"'{name}' is offline (last seen {_when(target['last_seen']) or 'never'})")
    if not target["capabilities"].get("remote"):
        raise Unavailable(f"'{name}' does not accept remote control")

    hub = music.connect
    since = hub.cursor()
    try:
        event = hub.command(_listener(ctx), None, target["id"], command, arguments)
    except ConnectError as error:
        raise CommandError(str(error))
    result = {"device": {"id": target["id"], "name": name}, "command": command, "arguments": event["arguments"],
              "event": event["id"], "confirmed": None}
    if wait:
        state = hub.wait_for_state(_listener(ctx), target["id"], since, wait)
        if state is None:
            raise CommandTimeout(f"sent '{command}' to '{name}', but it did not confirm within {wait}s",
                                 data=result)
        result.update(confirmed=True, state=state)
    return result


def _render_sent(data: dict) -> str:
    done = "done" if data["confirmed"] else "sent"
    return f"{data['command'].capitalize()} {done} - {data['device']['name']}."


def _control(command: str):
    def handler(ctx, device, wait):
        return _send(ctx, device, command, {}, wait)
    return handler


def seek(ctx, position, device, wait):
    return _send(ctx, device, "seek", {"position": position}, wait)


def position(raw: str) -> float:
    """Seconds ("83", "83.5") or a clock ("1:23", "1:02:03")."""
    parts = raw.split(":")
    if len(parts) > 3:
        raise ValueError(f"'{raw}' is not a position - use seconds or m:ss")
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        raise ValueError(f"'{raw}' is not a position - use seconds or m:ss")
    if any(number < 0 or number != number for number in numbers) or any(number >= 60 for number in numbers[1:]):
        raise ValueError(f"'{raw}' is not a position - use seconds or m:ss")
    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60 + number
    if seconds > 24 * 3600:
        raise ValueError("a position must be under 24 hours")
    return seconds


position.__name__ = "position"

DEVICE = Option("device", "the device's id, name or the start of its name (default: the active device)",
                metavar="device")
WAIT = Option("wait", f"wait up to this many seconds for the device to confirm (0-{WAIT_LIMIT})",
              type=bounded(0, WAIT_LIMIT), default=0, metavar="seconds")
COUNT = Argument("count", f"how many to show (default {LIST_LIMIT})", type=bounded(1, 10_000), required=False)
OFFSET = Option("offset", "skip this many first", type=bounded(0, 10_000_000), default=0, metavar="n")
PLAYLIST = Argument("playlist", "a playlist id, or its exact name")
KIND = Option("kind", "what kind of item", choices=LIKE_KINDS, default="track", metavar="kind")
IDS = Argument("id", "track, album or artist ids", type=identifier, variadic=True)


def _counted(handler):
    def wrapped(ctx, count, offset):
        return handler(ctx, count or LIST_LIMIT, offset)
    return wrapped


def _playback(name: str, summary: str):
    return Command(name, summary, _control(name), CONTROL, options=(DEVICE, WAIT), mutates=True, remote=True,
                   requires_live=True, render=_render_sent,
                   examples=(f"music {name}", f"music {name} --device Pixel --wait 5"))


COMMANDS = [
    Command("stats", "Library totals: tracks, albums, artists, size and last scan", stats, READ,
            render=_render_stats, examples=("music", "music stats --json")),
    Command("scan", "Index the configured music folders, or one directory", scan, MANAGE,
            arguments=(Argument("directory", "a directory to scan instead of the configured sources",
                                required=False, variadic=True),),
            options=(Option("background", "start the scan and return at once", flag=True),),
            mutates=True, render=_render_scan, examples=("music scan", "music scan \"D:\\Music\\New\"",
                                                         "music scan --background")),
    Command("scan-status", "Whether a scan is running, and how the last one went", scan_status, READ,
            examples=("music scan-status --json",)),
    Command("tracks", "List tracks", _counted(tracks), READ, arguments=(COUNT,), options=(OFFSET,),
            render=_render_tracks, aliases=("list",), examples=("music tracks 20", "music tracks --offset 50")),
    Command("albums", "List albums", _counted(albums), READ, arguments=(COUNT,), options=(OFFSET,),
            render=_render_albums, examples=("music albums", "music albums 50 --json")),
    Command("artists", "List album artists", _counted(artists), READ, arguments=(COUNT,), options=(OFFSET,),
            render=_render_artists, examples=("music artists 25",)),
    Command("likes", "List liked tracks, albums or artists", likes, READ, options=(KIND,), render=_render_likes,
            examples=("music likes", "music likes --kind album")),
    Command("like", "Like tracks, albums or artists", lambda ctx, id, kind: _set_like(ctx, id, kind, True),
            CONTROL, arguments=(IDS,), options=(KIND,), mutates=True, remote=True, render=_render_like,
            examples=("music like 3f2a9c1d0b7e4a55",)),
    Command("unlike", "Remove likes", lambda ctx, id, kind: _set_like(ctx, id, kind, False), CONTROL,
            arguments=(IDS,), options=(KIND,), mutates=True, remote=True, render=_render_like,
            examples=("music unlike 3f2a9c1d0b7e4a55",)),
    Command("playlists", "List your playlists", playlists, READ, render=_render_playlists),
    Command("playlist", "Show one playlist's tracks", playlist, READ, arguments=(PLAYLIST,),
            render=_render_playlist, examples=("music playlist \"Road trip\"",)),
    Command("playlist-create", "Create an empty playlist", playlist_create, CONTROL,
            arguments=(Argument("name", "the playlist's name", variadic=True),),
            options=(Option("description", "a short description", metavar="text"),),
            mutates=True, remote=True, render=lambda data: f"Created '{data['name']}' [{data['id']}].",
            examples=("music playlist-create \"Road trip\"",)),
    Command("playlist-add", "Add tracks to a playlist", playlist_add, CONTROL,
            arguments=(PLAYLIST, Argument("tracks", "track ids", type=identifier, variadic=True)),
            options=(Option("allow-duplicates", "add tracks already in the playlist again", flag=True),),
            mutates=True, remote=True,
            render=lambda data: f"'{data['name']}' now has {data['track_count']} track(s).",
            examples=("music playlist-add \"Road trip\" 3f2a9c1d0b7e4a55",)),
    Command("playlist-remove", "Remove entries from a playlist (entry ids from 'music playlist')",
            playlist_remove, CONTROL,
            arguments=(PLAYLIST, Argument("entries", "entry ids", variadic=True)), mutates=True, remote=True,
            render=lambda data: f"'{data['name']}' now has {data['track_count']} track(s).",
            examples=("music playlist-remove \"Road trip\" 9c1d0b7e",)),
    Command("playlist-delete", "Delete a playlist", playlist_delete, CONTROL, arguments=(PLAYLIST,), mutates=True,
            confirm="Delete this playlist? This cannot be undone.",
            render=lambda data: f"Deleted '{data['name']}'.", examples=("music playlist-delete \"Road trip\" --yes",)),
    Command("devices", "List StarCore Connect devices and which can be controlled", devices, READ,
            render=_render_devices, examples=("music devices", "music devices --json")),
    Command("playback", "What a device is playing", playback, READ, options=(DEVICE,), render=_render_playback,
            aliases=("now",), examples=("music playback", "music playback --device Pixel")),
    _playback("play", "Resume playback on a device"),
    _playback("pause", "Pause playback on a device"),
    _playback("next", "Skip to the next track on a device"),
    _playback("previous", "Go back to the previous track on a device"),
    Command("seek", "Jump to a position in the current track", seek, CONTROL,
            arguments=(Argument("position", "seconds, or m:ss", type=position),), options=(DEVICE, WAIT),
            mutates=True, remote=True, requires_live=True, render=_render_sent,
            examples=("music seek 1:30", "music seek 95 --device Pixel")),
]
