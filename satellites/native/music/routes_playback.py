"""Playing music: streams, delivery plans, saved queues and StarCore Connect."""

import math

from starcore.api.response import error_response, file_response

from . import audio
from .connect import ConnectError
from .library import MusicScanError, readable_duration, readable_size
from .routing import identifier, ok, route

STREAM_CACHE = "private, max-age=3600"
QUALITIES = ("original", "high", "normal", "low")


def _plan(call, track_id: str):
    music = call.music
    track = music.catalog.track(track_id)
    if track is None or track["missing"]:
        raise LookupError(f"unknown track '{track_id}'")
    quality = call.query.get("quality", "original")
    if quality not in QUALITIES:
        quality = "original"
    codec = call.query.get("format") or music.preferences.get(call.user, "transcode_format")
    return track, music.transcoder.plan(track, quality, codec)


@route("GET")
def stream(call):
    if not call.path:
        return error_response("no track was requested")
    music = call.music
    # only identifiers the index knows become a path, so nothing else on the disk
    # can be reached through this route
    track, plan = _plan(call, identifier(call.segment(0), "track"))
    row = music.catalog.track_row(track["id"])
    try:
        path = music.track_path({"id": row["id"], "path": row["path"]})
    except MusicScanError as error:
        return error_response(str(error))
    if plan["delivery"] == "transcode":
        target = music.transcoder.transcode(row, plan)
        return file_response(target, plan["content_type"], STREAM_CACHE)
    return file_response(path, audio.CONTENT_TYPES.get(track["format"], "application/octet-stream"), STREAM_CACHE)


@route("GET")
def playback(call):
    """What the stream route will deliver for this quality, and how loud to play it."""
    music = call.music
    track, plan = _plan(call, identifier(call.segment(0), "track"))
    preferences = music.preferences.all(call.user)
    gain = _replaygain(track, preferences["replaygain"])
    query = f"?quality={call.query.get('quality', 'original')}"
    if plan["delivery"] == "transcode":
        query += f"&format={plan['codec']}"
    return ok({"track": track, "plan": plan, "stream": f"stream/{track['id']}{query}", "gain": gain,
               "normalize": preferences["normalize"]})


def _replaygain(track: dict, mode: str) -> dict:
    replaygain = track["replaygain"]
    if mode == "off":
        return {"db": 0, "source": None, "peak": None}
    order = ("album", "track") if mode == "album" else ("track", "album")
    for kind in order:
        value = replaygain.get(f"{kind}_gain")
        if value is not None:
            peak = replaygain.get(f"{kind}_peak")
            db = value
            if peak:
                # never boost a track past full scale
                headroom = -20 * math.log10(peak) if peak > 0 else 0
                db = min(db, headroom)
            return {"db": round(db, 2), "source": kind, "peak": peak}
    return {"db": 0, "source": None, "peak": None}


@route("GET", "POST")
def queue(call):
    music = call.music
    device = call.query.get("device") if call.method == "GET" else call.body.get("device")
    if call.method == "GET":
        state = music.connect.state(call.user, device) or music.connect.state(call.user)
        if state and call.query.get("expand") == "1":
            state = {**state, "tracks": music.catalog.tracks_by_ids(state["queue"])}
        return ok({"state": state})
    if not isinstance(device, str):
        raise ConnectError("a queue is saved for a device")
    if music.connect.device(call.user, device) is None:
        music.connect.register(call.user, device, call.body.get("name"), call.body.get("kind", "other"), call.session)
    return ok({"state": music.connect.save_state(call.user, device, call.body.get("state"))})


@route("GET", "POST")
def connect(call):
    music = call.music
    hub = music.connect
    action = call.segment(0)
    body = call.body

    if call.method == "GET":
        if action in (None, "devices"):
            return ok({"devices": hub.devices(call.user), "active": hub.active(call.user)})
        if action == "events":
            since = call.integer("since", 0, 0, 2 ** 62)
            timeout = call.integer("timeout", 25, 0, 30)
            return ok(hub.events(call.user, str(call.query.get("device", "")), since, timeout))
        if action == "cursor":
            return ok({"cursor": hub.cursor()})
        if action == "active":
            return ok({"active": hub.active(call.user)})
        return error_response(f"unknown connect action '{action}'")

    sender = body.get("device_id")
    if action == "register":
        return ok({"device": hub.register(call.user, sender, body.get("name"), body.get("kind"), call.session,
                                          body.get("capabilities")), "cursor": hub.cursor()})
    if action == "forget":
        return ok({"forgotten": hub.forget(call.user, str(body.get("target") or sender or ""))})
    if action == "state":
        return ok({"state": hub.save_state(call.user, sender, body.get("state"))})
    if action == "command":
        return ok({"event": hub.command(call.user, sender, body.get("target"), body.get("command"),
                                        body.get("arguments"))})
    if action == "transfer":
        return ok({"event": hub.transfer(call.user, sender, body.get("target"), body.get("source"),
                                         bool(body.get("play", True)))})
    return error_response(f"unknown connect action '{action}'")


@route("GET")
def mobile(call):
    """The generic declarative screen; StarCore's own app has dedicated Music screens instead."""
    summary = call.music.summary()
    return ok({"screen": {"title": "Music", "sections": [{"type": "card", "title": "Library", "items": [
        {"type": "status", "label": "Tracks", "value": str(summary["tracks"])},
        {"type": "status", "label": "Albums", "value": str(summary["albums"])},
        {"type": "status", "label": "Artists", "value": str(summary["artists"])},
        {"type": "status", "label": "Duration", "value": readable_duration(summary["duration"])},
        {"type": "status", "label": "Size", "value": readable_size(summary["size_bytes"])},
        {"type": "status", "label": "Last scan", "value": summary["last_scan"] or "never"},
        {"type": "button", "label": "Scan library", "action": {"route": "scan", "method": "POST"}},
    ]}]}})
