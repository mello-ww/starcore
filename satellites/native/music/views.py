"""What Music's shared interface (ui.json, UI contract 1.2) reads beside its own page.

Home by section (`home?view=shelves`), Your Library by tab (`library?tab=`), and the rows they
list: each track with its heart (`liked` and `not_liked`, a pair the document draws as one
toggle), its quality badge and the line under its title as text, and its position in the list.
A long list is never sent whole: it comes a page at a time (`cursor`), and the audio host asks
for the tracks at chosen positions (`positions`) to shuffle it, or for the list from a row on
(`from`) to play it from there (docs/media-audio.md, A2).
"""

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

