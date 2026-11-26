"""What Music's shared interface (ui.json, UI contract 1.2) reads beside the routes it shares with the player.

Home by section (`home?view=shelves`), Your Library by tab (`library?tab=`), and the rows they
list: each track with its heart (`liked` and `not_liked`, a pair the document draws as one
toggle), its quality badge and the line under its title as text, and its position in the list.
A long list is never sent whole: it comes a page at a time (`cursor`), and the audio host asks
for the tracks at chosen positions (`positions`) to shuffle it, or for the list from a row on
(`from`) to play it from there (docs/media-audio.md, A2). Settings, the scan and duplicates
(A5), Stats and Wrapped (A6) are shaped here too, so each page binds plain values.
"""

from datetime import datetime
from pathlib import Path

from . import grouping
from .catalog import VISIBLE

# a mosaic's album ids in one path segment ("artwork/mosaic/<id>.<id>.<id>.<id>"), as answers give them
MOSAIC_ALBUMS = 4

TABS = ("playlists", "liked", "albums", "artists", "recent", "folders", "genres")
PAGE = 100
MAX_PAGE = 500
# the most positions one request may ask for (the host asks for 50 at a time)
MAX_POSITIONS = 50
RECENT_TRACKS = 100
HOME_TRACKS = 8

LIKED_SORTS = {
    "added": "f.created_at DESC",
    "title": "t.title COLLATE NOCASE, t.artist COLLATE NOCASE",
    "artist": "t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no",
    "album": "t.album COLLATE NOCASE, t.disc_no, t.track_no",
}
ALBUM_SORTS = {"added": ("added", "desc"), "released": ("released", "desc"), "quality": ("quality", "desc"),
               "name": ("title", "asc")}
RELEASE_TYPES = ("album", "single", "ep", "compilation")
ARTIST_FILTERS = ("all", "featured", "followed")
QUALITIES = ("lossless", "hires")

# Home's sections by the key the document places them under (a binding path has no hyphen)
SHELVES = {"continue": "continue", "recent": "recent", "mixes": "mixes", "on-repeat": "listening",
           "albums": "albums", "artists": "artists", "added": "added", "recommended": "recommended",
           "liked": "liked", "genres": "genres", "moods": "moods", "start": "start"}


# ---------- rows ----------

def mosaic_key(album_ids: list) -> str:
    """Album ids as the one path segment artwork/mosaic/<key> takes."""
    return ".".join(album_ids[:MOSAIC_ALBUMS])


def badge(quality) -> str:
    """The quality badge a row shows: Hi-Res, Lossless, or nothing for a lossy file."""
    quality = quality or {}
    return "Hi-Res" if quality.get("hires") else "Lossless" if quality.get("lossless") else ""


def decorate(track: dict, liked: set, position: int = None) -> dict:
    """A track as a row draws it, in place: its heart, its badge and the lines under its title
    (`line` with the artist, `album_line` with the album), "Unavailable" for a missing file."""
    track_badge = badge(track.get("quality"))
    track["liked"] = track.get("id") in liked
    track["not_liked"] = not track["liked"]
    track["badge"] = track_badge
    if track.get("missing"):
        track["line"] = track["album_line"] = "Unavailable"
    else:
        artist = track.get("artist") or track.get("album_artist") or ""
        track["line"] = " · ".join(part for part in (track_badge, artist) if part)
        track["album_line"] = " · ".join(part for part in (track_badge, track.get("album") or "") if part)
    if position is not None:
        track["position"] = position
    return track


def track_row(track: dict, liked: set, position: int = None) -> dict:
    """The few fields a row and the audio host need, out of a full track (the host's player
    shows the quality)."""
    row = {key: track.get(key) for key in ("id", "title", "artist", "artist_id", "album", "album_id", "duration",
                                           "has_artwork", "quality", "missing")}
    for key in ("reason", "played_at"):
        if key in track:
            row[key] = track[key]
    return decorate(row, liked, position)


def liked_tracks(music, user: str) -> set:
    return set(music.collection.favorite_ids(user)["track"])


def flags(item: dict, liked: set, pinned: set, kind: str) -> dict:
    """An album's, an artist's or a playlist's saved and pinned state, each as a pair for a
    menu's two entries."""
    item["liked"] = item.get("id") in liked
    item["not_liked"] = not item["liked"]
    item["pinned"] = (kind, item.get("id")) in pinned
    item["not_pinned"] = not item["pinned"]
    return item


def pinned_set(music, user: str) -> set:
    return {(pin["kind"], pin["id"]) for pin in music.collection.pins(user)}


def length(seconds) -> str:
    minutes = round((seconds or 0) / 60)
    if minutes < 60:
        return f"{minutes} min"
    return f"{minutes // 60} h {minutes % 60} min" if minutes % 60 else f"{minutes // 60} h"


def songs(count: int) -> str:
    return f"{count:,} song" + ("" if count == 1 else "s")


# ---------- paging by position ----------

def page_of(ids: list, query: dict, fetch, limit: int) -> dict:
    """One page of a list known by its ids: `{tracks, count, cursor}`. `from` starts the list at
    a position (a row's play), `positions` picks tracks by position (a shuffle), `cursor` is
    where the next page starts. Positions are the list's own, so a row's `position` plays it."""
    start = _number(query.get("from"), 0)
    if start > len(ids):
        raise ValueError("'from' is past the end of the list")
    listed = ids[start:]
    wanted = query.get("positions")
    if wanted not in (None, ""):
        positions = _positions(wanted, len(listed))
        return {"tracks": fetch([listed[at] for at in positions], [start + at for at in positions]),
                "count": len(listed), "cursor": None}
    offset = _number(query.get("cursor"), 0)
    chunk = listed[offset:offset + limit]
    end = offset + len(chunk)
    return {"tracks": fetch(chunk, [start + offset + index for index in range(len(chunk))]),
            "count": len(listed), "cursor": str(end) if end < len(listed) else None}


def page_items(items: list, query: dict, limit: int) -> tuple:
    """A page of a list already built (albums, artists): the items and the next cursor."""
    offset = _number(query.get("cursor"), 0)
    chunk = items[offset:offset + limit]
    end = offset + len(chunk)
    return chunk, (str(end) if end < len(items) else None)


def _number(value, default: int) -> int:
    if value in (None, ""):
        return default
    text = str(value)
    if not text.isdigit() or len(text) > 9:
        raise ValueError("a cursor or position must be a whole number")
    return int(text)


def _positions(value, count: int) -> list:
    parts = str(value).split(",")
    if len(parts) > MAX_POSITIONS:
        raise ValueError(f"at most {MAX_POSITIONS} positions at a time")
    positions = [_number(part, 0) for part in parts]
    if any(position >= count for position in positions):
        raise ValueError("a position is past the end of the list")
    return positions


def _fetcher(music, liked: set):
    def fetch(ids: list, positions: list) -> list:
        found = {track["id"]: track for track in music.catalog.tracks_by_ids(ids)}
        return [track_row(found[track_id], liked, position)
                for track_id, position in zip(ids, positions) if track_id in found]
    return fetch


# ---------- Your Library ----------

def library(call) -> dict:
    """Only the selected tab's list (`tab`), filtered (`q`) and sorted on the server (`liked_sort`,
    `album_sort`, or `sort` for either; `type` for albums, `filter` for artists), paged where it
    is long, with `showing` naming the tab so each of the document's blocks shows by it."""
    music, user, query = call.music, call.user, call.query
    tab = query.get("tab") if query.get("tab") in TABS else "playlists"
    needle = grouping.normalize(query.get("q") or "")
    answer = {"tab": tab, "showing": {name: name == tab for name in TABS}, "q": query.get("q") or ""}
    liked = liked_tracks(music, user)
    pinned = pinned_set(music, user)
    if tab == "liked":
        ids = _liked_ids(music, user, query.get("liked_sort") or query.get("sort"), needle)
        answer.update(page_of(ids, query, _fetcher(music, liked), call.integer("limit", PAGE, 1, MAX_PAGE)))
        answer["context"] = "liked:all"
        answer["summary"] = songs(len(ids))
    elif tab == "recent":
        tracks = music.history.recent(user, RECENT_TRACKS)
        tracks = [track for track in tracks if _matches(needle, track.get("title"), track.get("artist"),
                                                        track.get("album"))]
        answer["tracks"] = [track_row(track, liked, index) for index, track in enumerate(tracks)]
        answer["context"] = "library:recent"
    elif tab == "albums":
        sort, order = ALBUM_SORTS.get(query.get("album_sort") or query.get("sort"), ALBUM_SORTS["added"])
        release = query.get("type") if query.get("type") in RELEASE_TYPES else None
        saved = set(music.collection.favorite_ids(user)["album"])
        albums = [flags(album, saved, pinned, "album") for album in
                  music.catalog.albums(sort=sort, order=order, release=release)
                  if _matches(needle, album["album"], album["artist"])]
        albums.sort(key=lambda album: not album["pinned"])
        answer["albums"], answer["cursor"] = page_items(albums, query, call.integer("limit", 60, 1, MAX_PAGE))
        answer["count"] = len(albums)
    elif tab == "artists":
        shown = query.get("filter") if query.get("filter") in ARTIST_FILTERS else "all"
        followed = music.collection.favorite_ids(user)["artist"]
        artists = (music.catalog.artists_by_id(followed) if shown == "followed"
                   else music.catalog.artists(include_featured=shown == "featured"))
        artists = [flags(artist, set(followed), pinned, "artist") for artist in artists
                   if _matches(needle, artist["name"])]
        artists.sort(key=lambda artist: (not artist["pinned"], (artist["name"] or "").lower()))
        answer["artists"], answer["cursor"] = page_items(artists, query, call.integer("limit", 60, 1, MAX_PAGE))
        answer["count"] = len(artists)
    elif tab == "playlists":
        answer["playlists"] = [playlist for playlist in playlist_rows(music, user)
                               if _matches(needle, playlist["name"], playlist["folder"])]
    elif tab == "folders":
        answer["sources"] = _sources(music)
    elif tab == "genres":
        answer["genres"] = [genre for genre in music.catalog.genres() if _matches(needle, genre["name"])]
    return answer


def playlist_rows(music, user: str) -> list:
    """The listener's playlists, pinned first (under Pinned), then by folder: each with its
    folder as a group, its mosaic and its summary line."""
    pinned = pinned_set(music, user)
    rows = []
    for playlist in music.playlists.list(user):
        flags(playlist, set(), pinned, "playlist")
        playlist.pop("liked")
        playlist.pop("not_liked")
        playlist["group"] = "Pinned" if playlist["pinned"] else playlist["folder"] or "Playlists"
        playlist["mosaic_key"] = mosaic_key(playlist.get("mosaic") or [])
        playlist["line"] = " · ".join(part for part in (
            "Smart playlist" if playlist.get("smart") else "", songs(playlist.get("tracks") or 0),
            length(playlist.get("duration")) if playlist.get("duration") else "") if part)
        rows.append(playlist)
    rows.sort(key=lambda row: (not row["pinned"], row["folder"] != "" and not row["pinned"], row["folder"].lower()))
    return rows


def _liked_ids(music, user: str, sort, needle: str) -> list:
    where, params = [VISIBLE, "f.user = ?", "f.kind = 'track'"], [user]
    for token in needle.split()[:8]:
        where.append("(t.title LIKE ? ESCAPE '!' OR t.artist LIKE ? ESCAPE '!' OR t.album LIKE ? ESCAPE '!')")
        pattern = "%" + token.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
        params += [pattern, pattern, pattern]
    order = LIKED_SORTS.get(sort, LIKED_SORTS["added"])
    return [row[0] for row in music.db.all(
        f"SELECT t.id FROM favorites f JOIN tracks t ON t.id = f.item_id WHERE {' AND '.join(where)} "
        f"ORDER BY {order}", params)]


def _matches(needle: str, *values) -> bool:
    if not needle:
        return True
    return all(any(token in grouping.normalize(value) for value in values if value) for token in needle.split())


def _sources(music) -> list:
    sources = [str(path) for path in music.source_paths()]
    roots = sources + [source for source in music.catalog.sources() if source not in sources]
    return [{"index": index, "name": Path(root).name or root, "path": ""} for index, root in enumerate(roots)]


# ---------- a folder ----------

def folder_view(listing: dict, index: int, liked: set) -> dict:
    """A folder's breadcrumb from its source down, its subfolders and its tracks as rows, each
    knowing its source so it opens its own folder page."""
    parts = [part for part in listing["path"].split("/") if part]
    crumbs = [{"source": index, "path": "", "name": listing.pop("source_name")}]
    for depth, part in enumerate(parts):
        crumbs.append({"source": index, "path": "/".join(parts[:depth + 1]), "name": part})
    listing["crumbs"] = crumbs
    listing["name"] = crumbs[-1]["name"]
    for child in listing["folders"]:
        child["source"] = index
        child["line"] = songs(child["tracks"])
    for position, track in enumerate(listing["tracks"]):
        decorate(track, liked, position)
    listing["context"] = f"folder:{index}"
    return listing


# ---------- Home ----------

def home(music, user: str, answer: dict) -> dict:
    """Home's sections keyed by id (`shelves`), each as the tiles or rows its block draws, so
    the document places each one and shows it while it is there."""
    liked = liked_tracks(music, user)
    pinned = pinned_set(music, user)
    saved = set(music.collection.favorite_ids(user)["album"])
    followed = set(music.collection.favorite_ids(user)["artist"])
    mixes = {item["id"]: item for section in answer["sections"] if section["kind"] == "mixes"
             for item in section["items"]}
    shelves = {}
    for section in answer["sections"]:
        key = SHELVES.get(section["id"])
        if key is None:
            continue
        kind, items = section["kind"], section["items"]
        if kind == "tracks":
            items = [track_row(track, liked, index) for index, track in enumerate(items[:HOME_TRACKS])]
        elif kind == "albums":
            items = [flags(album, saved, pinned, "album") for album in items]
        elif kind == "artists":
            items = [flags(artist, followed, pinned, "artist") for artist in items]
        elif kind == "mixes":
            items = [_mix_tile(mix) for mix in items]
        elif kind == "moods":
            items = [_mood_tile(music, mood) for mood in items]
        elif kind == "contexts":
            items = [tile for tile in (_context_tile(music, entry, mixes) for entry in items) if tile]
        if items:
            shelves[key] = {"title": section["title"], "subtitle": section.get("subtitle"), "items": items}
    return {"greeting": answer["greeting"], "personalized": answer["personalized"], "shelves": shelves,
            "empty": not music.catalog.count(), "context": "home"}


def _mix_tile(mix: dict) -> dict:
    return {"id": mix["id"], "name": mix["name"], "description": mix.get("description"),
            "mosaic_key": mosaic_key(mix.get("mosaic") or []), "tracks": mix.get("tracks")}


def _mood_tile(music, mood: dict) -> dict:
    genres = mood.get("genres") or []
    covers = []
    if genres:
        marks = ",".join("?" * len(genres))
        covers = [row[0] for row in music.db.all(
            f"SELECT album_id FROM tracks t WHERE {VISIBLE} AND has_artwork = 1 AND genre IN ({marks}) "
            f"GROUP BY album_id ORDER BY MAX(added_at) DESC LIMIT 4", genres)]
    # a mood opens as a mix (`mixes/mood-<id>`), so a mixed shelf opens both one way
    return {"id": f"mood-{mood['id']}", "name": mood["name"], "description": ", ".join(genres[:3]),
            "mosaic_key": mosaic_key(covers), "tracks": mood.get("tracks")}


def _context_tile(music, entry: dict, mixes: dict):
    """One tile of Continue listening, saying how it opens (`is_album` and the like): an album,
    a playlist, an artist, or a mix or mood (both open as a mix). Radio stations are left out:
    each is built afresh."""
    kind, item = entry["kind"], entry["item"]
    tile = {"kind": kind, "id": item["id"], "is_album": False, "is_playlist": False, "is_artist": False,
            "is_mix": False}
    if kind == "album":
        tile.update(title=item["album"], subtitle=item["artist"], is_album=True,
                    mosaic_key=item["id"] if item.get("artwork") else "")
    elif kind == "playlist":
        tile.update(title=item["name"], subtitle="Playlist", is_playlist=True,
                    mosaic_key=mosaic_key(item.get("mosaic") or []))
    elif kind == "artist":
        artist = next(iter(music.catalog.artists_by_id([item["id"]])), None)
        tile.update(title=item["name"], subtitle="Artist", is_artist=True,
                    mosaic_key=(artist or {}).get("artwork") or "")
    elif kind == "mix" and item["id"] in mixes:
        mix = mixes[item["id"]]
        tile.update(title=mix["name"], subtitle="Mix", is_mix=True, mosaic_key=mosaic_key(mix.get("mosaic") or []))
    elif kind == "mix" and item["id"].startswith("mood-"):
        tile.update(title=item["id"][5:].replace("-", " ").title(), subtitle="Mood", is_mix=True, mosaic_key="")
    else:
        return None
    return tile


# ---------- Search ----------

def search(music, user: str, answer: dict, liked: set) -> dict:
    """Search's answer as the document reads it: rows with hearts, the top result as one tile
    saying how it opens, the first songs apart, and, while the field is empty, the recent
    searches and the genres to browse."""
    query = answer.get("query") or ""
    for position, track in enumerate(answer["tracks"]):
        decorate(track, liked, position)
    answer["songs"] = answer["tracks"][:5]
    top = answer.get("top")
    answer["top_tiles"] = []
    if top:
        item = top["item"]
        tile = {"kind": top["kind"], "id": item["id"], "is_artist": top["kind"] == "artist",
                "is_album": top["kind"] == "album", "is_track": top["kind"] == "track"}
        if top["kind"] == "artist":
            tile.update(title=item["name"], subtitle="Artist", mosaic_key=item.get("artwork") or "")
        elif top["kind"] == "album":
            tile.update(title=item["album"], subtitle=f"Album · {item['artist']}",
                        mosaic_key=item["id"] if item.get("artwork") else "")
        else:
            tile.update(title=item["title"], subtitle=f"Song · {item.get('artist') or ''}",
                        mosaic_key=item["album_id"] if item.get("has_artwork") else "", album_id=item["album_id"])
        answer["top_tiles"] = [tile]
    for playlist in answer["playlists"]:
        playlist["mosaic_key"] = mosaic_key(playlist.get("mosaic") or [])
        playlist["line"] = songs(playlist.get("tracks") or 0)
    answer["idle"] = not grouping.normalize(query)
    answer["searching"] = not answer["idle"]
    corrected = answer.get("corrected")
    answer["corrected_text"] = f"Showing results for “{corrected}”" if corrected else ""
    answer["found"] = not answer["idle"] and any(answer[key] for key in ("tracks", "albums", "artists",
                                                                         "playlists", "genres"))
    answer["nothing"] = not answer["idle"] and not answer["found"]
    answer["recent"] = ([{"query": text} for text in music.collection.recent_searches(user)]
                        if answer["idle"] else [])
    answer["has_recent"] = bool(answer["recent"])
    answer["browse"] = music.catalog.genres()[:24] if answer["idle"] else []
    answer["context"] = "search:" + (grouping.normalize(query).replace(" ", "-")[:60] or "all")
    return answer


# ---------- Settings (A5) ----------

ACCENTS = ("starcore", "artwork")
SCAN_FAILURES = 50
DUPLICATE_GROUPS = 50


def epoch(stamp):
    """An ISO time as the epoch seconds the document's date formats take, or None."""
    if not stamp:
        return None
    try:
        return int(datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def settings(music, user: str, session: str, config: dict, transcoding: bool) -> dict:
    """The Settings page in one answer: the listener's preferences at the top level (so each
    control binds `$.<key>`), the accent as a mode and a colour, the library's totals, the
    server's configuration as form values (lists as rows), and the listener's devices, each
    saying whether it is the one asking and so can't be forgotten from here."""
    answer = music.preferences.all(user)
    accent = str(answer.get("accent") or "starcore")
    answer["accent_mode"] = accent if accent in ACCENTS else "custom"
    answer["accent_colour"] = "" if accent in ACCENTS else accent
    summary = music.summary()
    answer["library"] = {key: summary[key] for key in ("tracks", "albums", "artists", "duration", "size_bytes",
                                                       "lossless", "hires", "missing")}
    answer["transcoding"] = bool(transcoding)
    answer["no_transcoding"] = not transcoding
    answer["transcoding_label"] = "Available" if transcoding else "Unavailable"
    answer["config"] = {**config, "sources": [{"path": path} for path in config.get("sources") or []],
                        "exclude": [{"pattern": pattern} for pattern in config.get("exclude") or []]}
    answer["devices"] = devices(music, user, session)
    answer["has_devices"] = bool(answer["devices"])
    return answer


def accent_change(body: dict) -> dict:
    """The accent from a form's mode and colour: a custom mode stores the colour (checked as
    #rrggbb by the preferences), the others store the mode itself."""
    changes = {key: value for key, value in body.items() if key not in ("accent_mode", "accent_colour")}
    if "accent_mode" in body:
        mode = body.get("accent_mode")
        changes["accent"] = str(body.get("accent_colour") or "").strip() if mode == "custom" else mode
    return changes


def devices(music, user: str, session: str) -> list:
    here = {row[0] for row in music.db.all("SELECT device_id FROM devices WHERE user = ? AND session_id = ?",
                                           (user, session or ""))} if session else set()
    rows = []
    for device in music.connect.devices(user):
        this = device["id"] in here
        state = "This device" if this else "Online" if device["online"] else "Offline"
        rows.append({"id": device["id"], "name": device["name"] or "Unnamed device",
                     "line": " · ".join(part for part in (state, (device.get("kind") or "").capitalize()) if part),
                     "last_seen": int(device["last_seen"] or 0) or None, "this": this, "forgettable": not this})
    return rows


def scan(status: dict) -> dict:
    """The scan as its page shows it: running or idle, one line of what it did or is doing,
    the files it couldn't read and its error (a cancel is not one)."""
    answer = {"running": bool(status.get("running")), "idle": not status.get("running"),
              "last_scan": epoch(status.get("last_scan"))}
    progress, last = status.get("progress"), status.get("last")
    if answer["running"]:
        line = "Scanning…"
        if progress:
            line = (f"Scanning… {progress.get('found', 0):,} files checked, {progress.get('added', 0):,} new, "
                    f"{progress.get('updated', 0):,} updated")
        answer["line"] = line
        answer["current"] = (progress or {}).get("current") or ""
    elif last:
        answer["line"] = (f"{last.get('found', 0):,} files, {last.get('added', 0):,} added, "
                          f"{last.get('updated', 0):,} updated, {last.get('removed', 0):,} missing, "
                          f"{last.get('duplicates', 0):,} duplicates.")
        answer["current"] = ""
    else:
        answer["line"] = "Never scanned."
        answer["current"] = ""
    failed = (last or {}).get("failed") or [] if not answer["running"] else []
    answer["failed"] = [{"file": str(entry.get("file") or ""), "reason": str(entry.get("reason") or "")}
                        for entry in failed[:SCAN_FAILURES] if isinstance(entry, dict)]
    answer["failed_line"] = f"{len(failed):,} unreadable files" + (
        f", the first {SCAN_FAILURES} below" if len(failed) > SCAN_FAILURES else "") if failed else ""
    error = status.get("error")
    answer["error"] = error if error and error != "cancelled" else ""
    return answer


def duplicates(found: dict, liked: set) -> dict:
    """Duplicates as one list of tracks, each likely group under its own heading, the best copy
    first and saying so. Byte-identical copies are counted only: the scan indexed them once."""
    tracks = []
    for number, group in enumerate(found.get("likely", [])[:DUPLICATE_GROUPS], start=1):
        heading = f"{number}. {group['tracks'][0].get('title') or 'Untitled'}"
        for track in group["tracks"]:
            row = track_row(track, liked, len(tracks))
            row["group"] = heading
            if track["id"] == group["best"]:
                row["album_line"] = " · ".join(part for part in ("Best copy", row["album_line"]) if part)
            tracks.append(row)
    identical, likely = len(found.get("identical", [])), len(found.get("likely", []))
    return {"tracks": tracks, "context": "library:duplicates", "has_tracks": bool(tracks),
            "summary": (f"{songs(identical)} with identical copies elsewhere on disk (indexed once), "
                        f"{likely:,} likely duplicate group{'' if likely == 1 else 's'} across releases. "
                        "Nothing is ever deleted.")}


# ---------- Stats and Wrapped (A6) ----------

RANGES = (7, 30, 90, 365, 0)


def plays(count: int) -> str:
    return f"{count:,} play" + ("" if count == 1 else "s")


def _rankings(music, answer: dict, liked: set) -> None:
    """The rankings as rows: songs as track rows (with their plays as `meta`), artists and albums
    with their artwork, genres by name."""
    tracks = []
    for entry in answer.get("top_tracks", []):
        if entry.get("track"):
            row = track_row(entry["track"], liked, len(tracks))
            row["plays_line"] = plays(entry["plays"])
            tracks.append(row)
    answer["top_songs"] = tracks
    artists = {artist["id"]: artist for artist in music.catalog.artists_by_id(
        [entry["id"] for entry in answer.get("top_artists", []) if entry.get("id")])}
    for entry in answer.get("top_artists", []):
        entry["name"] = entry.get("name") or "Unknown artist"
        entry["line"] = f"{entry.get('minutes', 0):,} min · {plays(entry.get('plays', 0))}"
        entry["artwork"] = (artists.get(entry.get("id")) or {}).get("artwork") or ""
    for entry in answer.get("top_albums", []):
        entry["album"] = entry.get("album") or "Unknown album"
        entry["line"] = " · ".join(part for part in (entry.get("artist") or "", plays(entry.get("plays", 0))) if part)
    for entry in answer.get("top_genres", []):
        entry["line"] = plays(entry.get("plays", 0))
    answer["has_plays"] = bool(answer.get("plays"))
    answer["no_plays"] = not answer["has_plays"]


def stats(music, user: str, answer: dict, days: int, year: int) -> dict:
    """Stats as the dashboard reads them: the range it covers, the rankings as rows, plays by
    hour as plain numbers for a bars chart, and the way to this year's Wrapped."""
    _rankings(music, answer, liked_tracks(music, user))
    answer["days"] = days
    answer["range"] = f"Last {days} days" if days else "All time"
    answer["context"] = "library:stats"
    answer["wrapped_year"] = year
    answer["wrapped_label"] = f"{year} Wrapped"
    return answer


def wrapped(music, user: str, answer: dict, current_year: int, first_year) -> dict:
    """Wrapped for one year: its rankings as rows, its tiles as text, and the years before and
    after it that have a Wrapped (`previous`, `next`), from the first year with a play to this one."""
    year = answer["year"]
    _rankings(music, answer, liked_tracks(music, user))
    answer["previous"] = year - 1 if first_year is not None and year - 1 >= first_year else None
    answer["next"] = year + 1 if year + 1 <= current_year else None
    answer["previous_label"] = str(year - 1)
    answer["next_label"] = str(year + 1)
    answer["title"] = f"{year} Wrapped"
    answer["streak_line"] = f"{answer.get('longest_streak', 0):,} day" + ("" if answer.get("longest_streak") == 1 else "s")
    peak = answer.get("peak_hour")
    answer["peak_line"] = f"{peak}:00" if peak is not None else "—"
    busiest = answer.get("busiest_day")
    answer["busiest_line"] = f"{busiest['day']} ({busiest['minutes']:,} min)" if busiest else "—"
    discovered = {artist["id"]: artist for artist in music.catalog.artists_by_id(
        [entry["id"] for entry in answer.get("new_artists", []) if entry.get("id")])}
    for entry in answer.get("new_artists", []):
        entry["line"] = f"First played {str(entry.get('first_play') or '')[:10]}"
        entry["artwork"] = (discovered.get(entry["id"]) or {}).get("artwork") or ""
    answer["play_label"] = f"Play your top songs of {year}"
    answer["context"] = f"mix:wrapped-{year}"
    return answer

