"""files.open: playing a sound by its path, from another interface's "Opens with".

The path comes from a client, so it is never trusted: every question about it goes to whichever
Satellite provides `files.browse`, with the user's own session (starcore.capabilities.call), so
that Satellite's roots and the protected areas apply exactly as when the user browses. A file the
user may not browse is a 404, never a hint that it exists. This module names no other Satellite.

A sound the library already holds opens that track's page. Any other sound becomes an
**external track**: a row of `tracks` flagged `external`, with its tags, kept so it can be
played, queued and added to playlists like any track, but never part of the library (every
library query leaves it out, a scan leaves it alone). It is checked again, with the session
asking, each time it is played or its playlist is loaded: a file moved, deleted or locked since
shows as missing, the state a playlist already has. One that no playlist, saved queue or recent
play holds is dropped once it has not been used for a while.

Nothing about a file of a protected area is kept: one is refused even while the session has the
area open, and an external track whose file a protected area comes to hold is dropped (its tags,
plays and transcodes) at its next check. A track keeps the real path it was opened at: when that
path leads somewhere else later (a link put in its way), it is missing, never the other file.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePath

from starcore import capabilities
from starcore.api.response import error_response

from . import audio, grouping
from .db import now
from .routing import ok, route
from .scanner import ROW_COLUMNS, Scanner, fingerprint

BROWSE = "files.browse"
# what this Satellite plays, by the file's extension (.mp4 is left to the interfaces that show video)
OPENS = frozenset(extension for extension in audio.FORMATS if extension != ".mp4")
# one pass never asks about more files than this: a playlist holds at most that many outside tracks
CHECKED = 200
IDLE_DAYS = 30


def _usable(path) -> bool:
    return isinstance(path, str) and bool(path) and len(path) <= 4096 and "\x00" not in path


def browsed(request, path):
    """The file's {name, path, size, ...} as the browsing Satellite answers for this session, or
    None for anything that is not a file the session may browse, whatever the reason."""
    if not _usable(path):
        return None
    answer = capabilities.call(request.engine, BROWSE, "stat", query={"path": path}, token=request.token)
    payload = getattr(answer, "payload", None)
    if answer is None or answer.status != 200 or not isinstance(payload, dict) or payload.get("type") != "file":
        return None
    return payload


def stat(request, path):
    """`browsed`, for a sound this Satellite plays (by its extension) only."""
    if not _usable(path) or PurePath(path).suffix.lower() not in OPENS:
        return None
    return browsed(request, path)


def readable(request, path) -> bool:
    """Whether this session may browse the file at `path`, and `path` is where it really is (no
    link on the way): what a file read beside an external track (its lyrics) must pass."""
    found = browsed(request, str(path))
    return found is not None and found.get("path") == str(path)


def protected(request, path) -> bool:
    """Whether `path` is in a protected area, open for this session or not."""
    return capabilities.protection(request.engine, path, request.token).protected


def location(request, path):
    """The file's path, if this session may browse it: what Show in folder asks about. The
    path is only ever handed to a client for a file it could open in the browsing Satellite."""
    found = browsed(request, path)
    return found["path"] if found else None


# ---------- external tracks ----------

def refresh(music, request, track_ids) -> None:
    """Asks again, for each external track among `track_ids`, whether this session may still
    read its file, and records the answer (`missing`) and the use (`last_used`). A file whose
    size changed, or that comes back, is read again, so its tags follow. A file now in a
    protected area takes its track with it; one gone, or whose path now leads elsewhere, leaves
    no transcode behind."""
    ids = [track_id for track_id in dict.fromkeys(track_ids) if isinstance(track_id, str)]
    if not ids:
        return
    rows = []
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        rows += music.db.all(f"SELECT id, path, size, missing FROM tracks WHERE external = 1 AND id IN ({marks})", chunk)
    stamp = now()
    for row in rows[:CHECKED]:
        if protected(request, row["path"]):
            forget(music, [row["id"]])
            continue
        found = stat(request, row["path"])
        if found is not None and found.get("path") != row["path"]:
            # the path now leads to another file (a link in its way): not the one that was opened
            found = None
        if found is not None and (found.get("size") != row["size"] or row["missing"]):
            try:
                register(music, found)
                continue
            except (OSError, audio.UnsupportedAudio):
                found = None
        if found is None and not row["missing"]:
            music.transcoder.forget(row["id"])
        music.db.execute("UPDATE tracks SET missing = ?, last_used = ? WHERE id = ?",
                         (int(found is None), stamp, row["id"]))


def refresh_playlist(music, request, playlist_id) -> None:
    refresh(music, request, [row["track_id"] for row in music.db.all(
        "SELECT e.track_id FROM playlist_tracks e JOIN tracks t ON t.id = e.track_id AND t.external = 1 "
        "WHERE e.playlist_id = ?", (playlist_id,))])


def register(music, found: dict) -> str:
    """Keeps the sound `found` (a stat answer) as an external track, or reads it again if it
    already is one; returns its id. The file is read only after the browsing Satellite let this
    session see it."""
    path = Path(found["path"])
    status = path.stat()
    info = audio.probe(path)
    content = fingerprint(path, status.st_size)
    row = Scanner(music.db, music.root, music.options)._row(path.parent, path, status, info, content)
    # no album, no artist page, no cover: nothing in the library names this sound
    row.update(external=1, folder="", album_id=None, artist_id=None, album_artist_id=None, has_artwork=0)

    known = music.db.one("SELECT id, external FROM tracks WHERE path = ?", (str(path),))
    stamp = now()
    with music.db.transaction() as connection:
        scanner = Scanner(music.db, music.root, music.options)
        if known is not None:
            row["id"] = known["id"]
            row.pop("added_at")
            scanner._update(connection, row)
        else:
            row["id"] = grouping.digest(content, path)
            marks = ",".join("?" * len(ROW_COLUMNS))
            connection.execute(f"INSERT INTO tracks ({','.join(ROW_COLUMNS)}) VALUES ({marks})",
                               [row[column] for column in ROW_COLUMNS])
            scanner._index(connection, row)
        connection.execute("UPDATE tracks SET last_used = ? WHERE id = ?", (stamp, row["id"]))
    return row["id"]


def purge(music) -> int:
    """Drops the external tracks nothing holds and nobody used for IDLE_DAYS: not in a playlist,
    not in a saved queue, not played since. Their plays and lyric offsets go with them."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=IDLE_DAYS)).isoformat(timespec="seconds")
    candidates = [row["id"] for row in music.db.all(
        "SELECT id FROM tracks WHERE external = 1 AND COALESCE(last_used, added_at, '') < ? "
        "AND id NOT IN (SELECT track_id FROM playlist_tracks) "
        "AND id NOT IN (SELECT track_id FROM plays WHERE played_at >= ?)", (cutoff, cutoff))]
    if not candidates:
        return 0
    queues = "\n".join(row["state"] or "" for row in music.db.all("SELECT state FROM playback_state"))
    dropped = [track_id for track_id in candidates if track_id not in queues]
    forget(music, dropped)
    return len(dropped)


def forget(music, track_ids) -> None:
    """Drops these external tracks and everything kept about them: their tags, plays, likes,
    lyric offsets and transcodes. A playlist keeps the entry, as missing, with no title."""
    track_ids = list(track_ids)
    with music.db.transaction() as connection:
        for track_id in track_ids:
            # keyed by the track's rowid: deleting by an UNINDEXED column would scan the whole index
            rowid = connection.execute("SELECT rowid FROM tracks WHERE id = ? AND external = 1",
                                       (track_id,)).fetchone()
            if rowid is None:
                continue
            connection.execute("DELETE FROM track_search WHERE rowid = ?", (rowid[0],))
            connection.execute("DELETE FROM track_artists WHERE track_id = ?", (track_id,))
            connection.execute("DELETE FROM plays WHERE track_id = ?", (track_id,))
            connection.execute("DELETE FROM lyrics_offsets WHERE track_id = ?", (track_id,))
            connection.execute("DELETE FROM favorites WHERE kind = 'track' AND item_id = ?", (track_id,))
            connection.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    for track_id in track_ids:
        music.transcoder.forget(track_id)


# ---------- the route ----------

@route("POST")
def open_file(call):
    """POST open {path} -> {page, params}: the page of this interface that shows the sound."""
    path = call.body.get("path")
    if not _usable(path):
        return error_response("name the file's absolute path", status=400)
    found = stat(call.request, path)
    if found is None:
        return error_response("that file can't be opened here", status=404)

    music = call.music
    held = music.db.one("SELECT id FROM tracks WHERE path = ? AND external = 0", (found["path"],))
    if held is not None:
        return ok({"page": "track", "params": {"id": held["id"]}})
    if protected(call.request, found["path"]):
        # even while the session has the area open: playing it here would mean keeping its tags
        return error_response("this file is in a protected area, so it can't be kept here", status=403)
    try:
        track_id = register(music, found)
    except (OSError, audio.UnsupportedAudio):
        return error_response("that file isn't a sound this library can play", status=415)
    purge(music)
    return ok({"page": "track", "params": {"id": track_id}})
