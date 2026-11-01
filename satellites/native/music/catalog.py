"""Read side of the library: tracks, albums, artists, genres and folders, straight from SQL.

Nothing here touches the disk. Payloads never carry an absolute path, so the API cannot
reveal where a collection lives; `path` is only added for the satellite's own callers.
"""

from . import grouping
from .db import loads

VISIBLE = "t.missing = 0 AND t.hidden = 0"

TRACK_SORTS = {
    "title": "t.title COLLATE NOCASE {order}",
    "artist": "t.album_artist COLLATE NOCASE {order}, t.album COLLATE NOCASE, t.disc_no, t.track_no",
    "album": "t.album COLLATE NOCASE {order}, t.disc_no, t.track_no",
    "added": "t.added_at {order}, t.album_id, t.disc_no, t.track_no",
    "released": "t.date {order}, t.album_id, t.disc_no, t.track_no",
    "duration": "t.duration {order}",
    "quality": "t.lossless {order}, t.bit_depth {order}, t.sample_rate {order}, t.bitrate {order}",
    "plays": "plays {order}, t.title COLLATE NOCASE",
    "random": "random()",
}
DEFAULT_TRACK_ORDER = ("t.album_artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no, "
                       "t.title COLLATE NOCASE")

ALBUM_SORTS = {
    "title": "album COLLATE NOCASE {order}",
    "artist": "artist COLLATE NOCASE {order}, album COLLATE NOCASE",
    "added": "added_at {order}",
    "released": "date {order}, album COLLATE NOCASE",
    "duration": "duration {order}",
    "quality": "lossless {order}, bit_depth {order}, sample_rate {order}",
    "random": "random()",
}

QUALITY_FILTERS = {
    "hires": "t.lossless = 1 AND (t.bit_depth >= 24 OR t.sample_rate > 48000)",
    "lossless": "t.lossless = 1",
    "lossy": "t.lossless = 0",
}


def track_payload(row, include_path: bool = False) -> dict:
    payload = {
        "id": row["id"],
        "title": row["title"],
        "artist": row["artist"],
        "artists": _artists(row),
        "artist_id": row["artist_id"],
        "album": row["album"],
        "album_id": row["album_id"],
        "album_artist": row["album_artist"],
        "album_artist_id": row["album_artist_id"],
        "track": row["track_no"],
        "track_total": row["track_total"],
        "disc": row["disc_no"],
        "disc_total": row["disc_total"],
        "year": row["year"],
        "date": row["date"],
        "genre": row["genre"],
        "genres": loads(row["genres"], []),
        "duration": row["duration"],
        "format": row["format"],
        "codec": row["codec"],
        "bitrate": row["bitrate"],
        "sample_rate": row["sample_rate"],
        "bit_depth": row["bit_depth"],
        "channels": row["channels"],
        "quality": grouping.quality(row["codec"], row["sample_rate"], row["bit_depth"], row["bitrate"],
                                    row["lossless"]),
        "size": row["size"],
        "filename": row["filename"],
        "folder": row["folder"],
        "has_artwork": bool(row["has_artwork"]),
        "has_lyrics": bool(row["has_lyrics"]),
        "compilation": bool(row["compilation"]),
        "replaygain": {
            "track_gain": row["rg_track_gain"], "track_peak": row["rg_track_peak"],
            "album_gain": row["rg_album_gain"], "album_peak": row["rg_album_peak"],
        },
        "credits": {
            "composer": row["composer"], "producer": row["producer"], "label": row["label"],
            "copyright": row["copyright"], "isrc": row["isrc"],
        },
        "musicbrainz": {
            "track": row["mb_track_id"], "album": row["mb_album_id"], "artist": row["mb_artist_id"],
            "release_group": row["mb_release_group_id"],
        },
        "missing": bool(row["missing"]),
        "hidden": bool(row["hidden"]),
        "added_at": row["added_at"],
        "indexed_at": row["indexed_at"],
        "mtime": row["mtime"],
    }
    if include_path:
        payload["path"] = row["path"]
    return payload


def _artists(row) -> list:
    names = loads(row["artists"], []) or ([row["artist"]] if row["artist"] else [])
    return [{"id": grouping.artist_id(name), "name": name} for name in names]


class Catalog:
    def __init__(self, db):
        self.db = db

    # ---------- tracks ----------

    def count(self) -> int:
        return self.db.value(f"SELECT COUNT(*) FROM tracks t WHERE {VISIBLE}", default=0)

    def totals(self) -> dict:
        row = self.db.one(f"SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(duration), 0), "
                          f"SUM(lossless), SUM(CASE WHEN lossless = 1 AND (bit_depth >= 24 OR sample_rate > 48000) "
                          f"THEN 1 ELSE 0 END) FROM tracks t WHERE {VISIBLE}")
        missing = self.db.value("SELECT COUNT(*) FROM tracks WHERE missing = 1", default=0)
        hidden = self.db.value("SELECT COUNT(*) FROM tracks WHERE hidden = 1 AND missing = 0", default=0)
        formats = {row[0]: row[1] for row in self.db.all(
            f"SELECT format, COUNT(*) FROM tracks t WHERE {VISIBLE} GROUP BY format")}
        return {"tracks": row[0], "size_bytes": row[1], "duration": round(row[2], 1),
                "lossless": row[3] or 0, "hires": row[4] or 0, "missing": missing, "hidden": hidden,
                "by_format": formats}

    def track_row(self, track_id):
        return self.db.one("SELECT * FROM tracks WHERE id = ?", (track_id,))

    def track(self, track_id, include_path=False):
        row = self.track_row(track_id)
        return track_payload(row, include_path) if row else None

    def tracks_by_ids(self, ids: list, include_missing: bool = False) -> list:
        """In the order asked for; unknown identifiers are dropped."""
        if not ids:
            return []
        found = {}
        unique = list(dict.fromkeys(ids))
        for start in range(0, len(unique), 500):
            chunk = unique[start:start + 500]
            marks = ",".join("?" * len(chunk))
            for row in self.db.all(f"SELECT * FROM tracks WHERE id IN ({marks})", chunk):
                if include_missing or (not row["missing"] and not row["hidden"]):
                    found[row["id"]] = track_payload(row)
        return [found[track_id] for track_id in ids if track_id in found]

    def tracks(self, sort=None, order="asc", limit=None, offset=0, genre=None, quality=None,
               album_id=None, artist_id=None, folder=None, source=None, include_hidden=False,
               user=None, include_path=False) -> dict:
        where = ["t.missing = 0"] if include_hidden else [VISIBLE]
        params = []
        if genre:
            where.append("(t.genre = ? COLLATE NOCASE OR t.genres LIKE ?)")
            params += [genre, f'%"{genre}"%']
        if quality in QUALITY_FILTERS:
            where.append(QUALITY_FILTERS[quality])
        if album_id:
            where.append("t.album_id = ?")
            params.append(album_id)
        if artist_id:
            where.append("t.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?)")
            params.append(artist_id)
        if folder is not None and source is not None:
            where.append("t.source = ? AND t.folder = ?")
            params += [source, folder]

        direction = "DESC" if str(order).lower() == "desc" else "ASC"
        order_sql = TRACK_SORTS[sort].format(order=direction) if sort in TRACK_SORTS else DEFAULT_TRACK_ORDER
        plays = ("(SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id AND p.user = ?)" if user is not None
                 else "0")
        plays_params = [user] if user is not None else []
        base = f"FROM tracks t WHERE {' AND '.join(where)}"
        total = self.db.value(f"SELECT COUNT(*) {base}", params, default=0)
        sql = f"SELECT t.*, {plays} AS plays {base} ORDER BY {order_sql}"
        page_params = plays_params + params
        if limit:
            sql += " LIMIT ? OFFSET ?"
            page_params += [int(limit), int(offset or 0)]
        rows = self.db.all(sql, page_params)
        items = []
        for row in rows:
            payload = track_payload(row, include_path)
            if user is not None:
                payload["plays"] = row["plays"]
            items.append(payload)
        return {"tracks": items, "total": total, "offset": int(offset or 0)}

    # ---------- albums ----------

    def _album_rows(self, where: str = "", params=(), sort=None, order="asc", limit=None, offset=0):
        direction = "DESC" if str(order).lower() == "desc" else "ASC"
        order_sql = ALBUM_SORTS[sort].format(order=direction) if sort in ALBUM_SORTS else \
            "artist COLLATE NOCASE, album COLLATE NOCASE"
        sql = f"""
            SELECT t.album_id AS id, MIN(t.album) AS album, MIN(t.album_artist) AS artist,
                   MIN(t.album_artist_id) AS artist_id, MIN(t.year) AS year, MAX(t.date) AS date,
                   COUNT(*) AS tracks, ROUND(SUM(COALESCE(t.duration, 0)), 1) AS duration,
                   MAX(t.compilation) AS compilation, MIN(t.added_at) AS added_at,
                   MAX(COALESCE(t.disc_no, 1)) AS discs, MIN(t.lossless) AS lossless,
                   MIN(t.bit_depth) AS bit_depth, MIN(t.sample_rate) AS sample_rate,
                   MIN(t.codec) AS codec, MIN(t.bitrate) AS bitrate, MIN(t.label) AS label,
                   MIN(t.genre) AS genre, MIN(t.mb_album_id) AS mb_album_id,
                   MAX(CASE WHEN t.has_artwork = 1 THEN t.id END) AS artwork
            FROM tracks t WHERE {VISIBLE} {where}
            GROUP BY t.album_id ORDER BY {order_sql}"""
        params = list(params)
        if limit:
            sql += " LIMIT ? OFFSET ?"
            params += [int(limit), int(offset or 0)]
        return self.db.all(sql, params)

    def albums(self, sort=None, order="asc", limit=None, offset=0, release=None, genre=None,
               artist_id=None) -> list:
        where, params = "", []
        if genre:
            where += " AND t.genre = ? COLLATE NOCASE"
            params.append(genre)
        if artist_id:
            where += " AND t.album_artist_id = ?"
            params.append(artist_id)
        albums = [_album_payload(row) for row in self._album_rows(where, params, sort, order, limit, offset)]
        if release:
            albums = [album for album in albums if album["type"] == release]
        return albums

    def albums_by_id(self, album_ids: list) -> list:
        album_ids = list(dict.fromkeys(album_ids))[:500]
        if not album_ids:
            return []
        marks = ",".join("?" * len(album_ids))
        found = {row["id"]: _album_payload(row) for row in self._album_rows(f"AND t.album_id IN ({marks})", album_ids)}
        return [found[album_id] for album_id in album_ids if album_id in found]

    def album_count(self) -> int:
        return self.db.value(f"SELECT COUNT(DISTINCT album_id) FROM tracks t WHERE {VISIBLE}", default=0)

    def album(self, album_id, user=None):
        rows = self._album_rows("AND t.album_id = ?", (album_id,))
        if not rows:
            return None
        album = _album_payload(rows[0])
        album["tracks"] = self.tracks(album_id=album_id, user=user)["tracks"]
        album["artists"] = _unique_artists(album["tracks"])
        album["credits"] = _album_credits(album["tracks"])
        album["genres"] = sorted({genre for track in album["tracks"] for genre in track["genres"]})
        return album

    # ---------- artists ----------

    def artists(self, sort=None, include_featured: bool = False) -> list:
        """Album artists by default: the artists a listener browses to."""
        role_filter = "" if include_featured else "AND ta.role = 'album'"
        rows = self.db.all(f"""
            SELECT ta.artist_id AS id, MIN(ta.name) AS name, COUNT(DISTINCT t.album_id) AS albums,
                   COUNT(DISTINCT t.id) AS tracks, MIN(t.added_at) AS added_at,
                   MAX(CASE WHEN t.has_artwork = 1 AND t.album_artist_id = ta.artist_id THEN t.album_id END)
                   AS artwork
            FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
            WHERE {VISIBLE} {role_filter}
            GROUP BY ta.artist_id""")
        artists = [{"id": row["id"], "name": row["name"], "albums": row["albums"], "tracks": row["tracks"],
                    "artwork": row["artwork"], "added_at": row["added_at"]} for row in rows]
        if sort == "added":
            artists.sort(key=lambda artist: artist["added_at"] or "", reverse=True)
        elif sort == "tracks":
            artists.sort(key=lambda artist: -artist["tracks"])
        else:
            artists.sort(key=lambda artist: (artist["name"] or "").lower())
        return artists

    def artists_by_id(self, artist_ids: list) -> list:
        artist_ids = list(dict.fromkeys(artist_ids))[:500]
        if not artist_ids:
            return []
        marks = ",".join("?" * len(artist_ids))
        rows = self.db.all(f"""
            SELECT ta.artist_id AS id, MIN(ta.name) AS name, COUNT(DISTINCT t.album_id) AS albums,
                   COUNT(DISTINCT t.id) AS tracks, MIN(t.added_at) AS added_at,
                   MAX(CASE WHEN t.has_artwork = 1 AND t.album_artist_id = ta.artist_id THEN t.album_id END)
                   AS artwork
            FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
            WHERE {VISIBLE} AND ta.artist_id IN ({marks}) GROUP BY ta.artist_id""", artist_ids)
        found = {row["id"]: {"id": row["id"], "name": row["name"], "albums": row["albums"], "tracks": row["tracks"],
                             "artwork": row["artwork"], "added_at": row["added_at"]} for row in rows}
        return [found[artist_id] for artist_id in artist_ids if artist_id in found]

    def artist_count(self) -> int:
        return self.db.value(f"SELECT COUNT(DISTINCT ta.artist_id) FROM track_artists ta JOIN tracks t "
                             f"ON t.id = ta.track_id WHERE {VISIBLE} AND ta.role = 'album'", default=0)

    def artist(self, artist_id, user=None):
        name = self.db.value("SELECT name FROM track_artists WHERE artist_id = ? LIMIT 1", (artist_id,))
        if name is None:
            return None
        own = self.albums(sort="released", order="desc", artist_id=artist_id)
        appears = [_album_payload(row) for row in self._album_rows(
            "AND t.album_artist_id != ? AND t.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?)",
            (artist_id, artist_id), sort="released", order="desc")]
        tracks = self.tracks(artist_id=artist_id, user=user, sort="plays" if user else None,
                             order="desc")["tracks"]
        if not tracks and not own:
            return None
        genres = {}
        for track in tracks:
            for genre in track["genres"] or ([track["genre"]] if track["genre"] else []):
                genres[genre] = genres.get(genre, 0) + 1
        return {
            "id": artist_id,
            "name": name,
            "albums": [album for album in own if album["type"] in ("album", "compilation")],
            "singles": [album for album in own if album["type"] in ("single", "ep")],
            "appears_on": appears,
            "top_tracks": tracks[:10],
            "tracks": len(tracks),
            "genres": sorted(genres, key=lambda genre: -genres[genre]),
            "artwork": next((album["id"] for album in own if album["artwork"]), None),
            "similar": self.similar_artists(artist_id, list(genres)),
        }

    def similar_artists(self, artist_id, genres: list, limit: int = 8) -> list:
        """Artists in this library sharing genres or credits, with the reason given."""
        scores = {}
        reasons = {}
        if genres:
            marks = ",".join("?" * len(genres))
            for row in self.db.all(f"""
                    SELECT ta.artist_id, MIN(ta.name), COUNT(*) FROM track_artists ta JOIN tracks t
                    ON t.id = ta.track_id WHERE {VISIBLE} AND ta.role = 'album' AND ta.artist_id != ?
                    AND t.genre IN ({marks}) GROUP BY ta.artist_id""", [artist_id, *genres]):
                scores[row[0]] = scores.get(row[0], 0) + min(row[2], 20)
                reasons[row[0]] = (row[1], "shares a genre")
        for row in self.db.all("""
                SELECT other.artist_id, MIN(other.name), COUNT(*) FROM track_artists mine
                JOIN track_artists other ON other.track_id = mine.track_id AND other.artist_id != mine.artist_id
                WHERE mine.artist_id = ? GROUP BY other.artist_id""", (artist_id,)):
            scores[row[0]] = scores.get(row[0], 0) + 25 * row[2]
            reasons[row[0]] = (row[1], "appears on the same tracks")
        ranked = sorted(scores, key=lambda key: -scores[key])[:limit]
        return [{"id": key, "name": reasons[key][0], "reason": reasons[key][1]} for key in ranked]

    # ---------- genres, folders, duplicates ----------

    def genres(self) -> list:
        rows = self.db.all(f"SELECT genre, COUNT(*), COUNT(DISTINCT album_id), "
                           f"(SELECT a.album_id FROM tracks a WHERE a.genre = t.genre AND a.has_artwork = 1 LIMIT 1) "
                           f"FROM tracks t WHERE {VISIBLE} AND genre IS NOT NULL AND genre != '' "
                           f"GROUP BY genre COLLATE NOCASE ORDER BY COUNT(*) DESC")
        return [{"name": row[0], "tracks": row[1], "albums": row[2], "artwork": row[3]} for row in rows]

    def sources(self) -> list:
        return [row[0] for row in self.db.all("SELECT DISTINCT source FROM tracks WHERE missing = 0 ORDER BY source")]

    def folder(self, source_index: int, folder: str, source_paths: list):
        """One level of a source's folder tree, from what the index knows - never the disk."""
        if source_index < 0 or source_index >= len(source_paths):
            return None
        source = source_paths[source_index]
        folder = folder.strip("/")
        prefix = f"{folder}/" if folder else ""
        rows = self.db.all(f"SELECT folder, COUNT(*) FROM tracks t WHERE {VISIBLE} AND source = ? "
                           f"AND (folder = ? OR folder LIKE ? ESCAPE '\\') GROUP BY folder",
                           (source, folder, _like_prefix(prefix)))
        if not rows and folder:
            return None
        children = {}
        for row in rows:
            name = row[0]
            if name == folder:
                continue
            child = name[len(prefix):].split("/")[0]
            children[child] = children.get(child, 0) + row[1]
        tracks = self.tracks(folder=folder, source=source, sort="title")["tracks"] if rows else []
        return {
            "source": source_index,
            "path": folder,
            "folders": [{"name": name, "path": f"{prefix}{name}", "tracks": count}
                        for name, count in sorted(children.items(), key=lambda item: item[0].lower())],
            "tracks": tracks,
        }

    def duplicates(self) -> dict:
        """Byte-identical copies the scan skipped, and likely duplicates across releases."""
        copies = {}
        for row in self.db.all("SELECT d.track_id, COUNT(*) FROM duplicates d GROUP BY d.track_id"):
            copies[row[0]] = row[1]
        identical = [{"track": track, "copies": copies[track["id"]]}
                     for track in self.tracks_by_ids(list(copies))]

        groups = {}
        for row in self.db.all(f"SELECT * FROM tracks t WHERE {VISIBLE}"):
            key = (grouping.normalize(row["title"]), grouping.normalize(row["artist"]),
                   round((row["duration"] or 0) / 3))
            if key[0]:
                groups.setdefault(key, []).append(row)
        likely = []
        for rows in groups.values():
            if len(rows) > 1 and len({row["album_id"] for row in rows}) > 1:
                ranked = sorted(rows, key=lambda row: (-(row["lossless"] or 0), -(row["bit_depth"] or 0),
                                                       -(row["bitrate"] or 0)))
                likely.append({"best": ranked[0]["id"], "tracks": [track_payload(row) for row in ranked]})
        return {"identical": identical, "likely": likely}


def _album_payload(row) -> dict:
    quality = grouping.quality(row["codec"], row["sample_rate"], row["bit_depth"], row["bitrate"], row["lossless"])
    return {
        "id": row["id"],
        "album": row["album"],
        "artist": row["artist"],
        "artist_id": row["artist_id"],
        "year": row["year"],
        "date": row["date"],
        "tracks": row["tracks"],
        "duration": row["duration"],
        "discs": row["discs"],
        "compilation": bool(row["compilation"]),
        "type": grouping.release_type(row["tracks"], row["duration"], bool(row["compilation"])),
        "artwork": row["artwork"],
        "added_at": row["added_at"],
        "label": row["label"],
        "genre": row["genre"],
        "quality": quality,
        "musicbrainz": row["mb_album_id"],
    }


def _unique_artists(tracks: list) -> list:
    seen = {}
    for track in tracks:
        for artist in track["artists"]:
            seen.setdefault(artist["id"], artist)
    return list(seen.values())


def _album_credits(tracks: list) -> dict:
    credits = {}
    for key in ("composer", "producer", "label", "copyright"):
        values = []
        for track in tracks:
            value = track["credits"][key]
            if value and value not in values:
                values.append(value)
        credits[key] = values
    return credits


def _like_prefix(prefix: str) -> str:
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%"
