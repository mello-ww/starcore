"""Playlists: ordered, user-owned lists of track identifiers, plain or rule-based."""

from pathlib import PurePosixPath, PureWindowsPath
import re
import secrets

from . import grouping
from .catalog import VISIBLE, track_payload
from .db import dumps, loads, now

MAX_TRACKS = 10_000
MAX_NAME = 120
MAX_DESCRIPTION = 1000
VISIBILITIES = ("private", "public")

RULE_FIELDS = {
    "title": ("t.title", "text"),
    "artist": ("t.artist", "text"),
    "album": ("t.album", "text"),
    "album_artist": ("t.album_artist", "text"),
    "genre": ("t.genre", "text"),
    "composer": ("t.composer", "text"),
    "label": ("t.label", "text"),
    "format": ("t.format", "text"),
    "folder": ("t.folder", "text"),
    "year": ("t.year", "number"),
    "duration": ("t.duration", "number"),
    "bitrate": ("t.bitrate", "number"),
    "sample_rate": ("t.sample_rate", "number"),
    "bit_depth": ("t.bit_depth", "number"),
    "lossless": ("t.lossless", "bool"),
    "added": ("t.added_at", "date"),
    "plays": ("(SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id AND p.user = :user)", "number"),
    "last_played": ("(SELECT MAX(played_at) FROM plays p WHERE p.track_id = t.id AND p.user = :user)", "date"),
    "liked": ("EXISTS (SELECT 1 FROM favorites f WHERE f.user = :user AND f.kind = 'track' AND f.item_id = t.id)",
              "bool"),
}
RULE_SORTS = {
    "added": "t.added_at", "title": "t.title COLLATE NOCASE", "artist": "t.artist COLLATE NOCASE",
    "year": "t.year", "plays": RULE_FIELDS["plays"][0], "last_played": RULE_FIELDS["last_played"][0],
    "random": "random()", "duration": "t.duration",
}


class PlaylistError(ValueError):
    pass


class Playlists:
    def __init__(self, db, catalog):
        self.db = db
        self.catalog = catalog

    # ---------- reading ----------

    def list(self, user: str) -> list:
        rows = self.db.all("""
            SELECT p.*, COUNT(e.entry_id) AS entries,
                   EXISTS (SELECT 1 FROM pins n WHERE n.user = p.owner AND n.kind = 'playlist' AND n.item_id = p.id)
                   AS pinned
            FROM playlists p LEFT JOIN playlist_tracks e ON e.playlist_id = p.id
            WHERE p.owner = ? GROUP BY p.id ORDER BY pinned DESC, p.updated_at DESC""", (user,))
        playlists = []
        for row in rows:
            summary = self._summary(row)
            if row["rules"]:
                tracks = self._smart_tracks(user, loads(row["rules"], {}))
                summary.update(tracks=len(tracks), duration=round(sum(track["duration"] or 0 for track in tracks), 1),
                               mosaic=_mosaic(tracks))
            else:
                summary.update(self._stats(row["id"]))
            playlists.append(summary)
        return playlists

    def get(self, user: str, playlist_id: str):
        row = self._owned(user, playlist_id)
        if row is None:
            return None
        playlist = self._summary(row)
        if row["rules"]:
            tracks = self._smart_tracks(user, loads(row["rules"], {}))
            entries = [{"entry_id": None, "added_at": None, **track} for track in tracks]
        else:
            entries = self._entries(playlist_id)
        playlist["tracks"] = entries
        playlist["unavailable"] = sum(1 for entry in entries if entry.get("missing"))
        playlist["duration"] = round(sum(entry["duration"] or 0 for entry in entries if not entry.get("missing")), 1)
        playlist["track_count"] = len(entries)
        playlist["mosaic"] = _mosaic(entries)
        return playlist

    def track_ids(self, user: str, playlist_id: str) -> list:
        playlist = self.get(user, playlist_id)
        return [entry["id"] for entry in playlist["tracks"] if not entry.get("missing")] if playlist else []

    def _entries(self, playlist_id: str) -> list:
        rows = self.db.all("""
            SELECT e.entry_id, e.added_at AS entry_added, e.track_id, t.* FROM playlist_tracks e
            LEFT JOIN tracks t ON t.id = e.track_id WHERE e.playlist_id = ? ORDER BY e.position""", (playlist_id,))
        entries = []
        for row in rows:
            if row["id"] is None:
                entries.append({"entry_id": row["entry_id"], "id": row["track_id"], "missing": True, "title": None,
                                "duration": None, "added_at": row["entry_added"]})
                continue
            payload = track_payload(row)
            payload["missing"] = bool(row["missing"] or row["hidden"])
            entries.append({"entry_id": row["entry_id"], **payload, "added_to_playlist": row["entry_added"]})
        return entries

    def _stats(self, playlist_id: str) -> dict:
        row = self.db.one("""SELECT COUNT(t.id), COALESCE(SUM(t.duration), 0) FROM playlist_tracks e
                             JOIN tracks t ON t.id = e.track_id AND t.missing = 0 WHERE e.playlist_id = ?""",
                          (playlist_id,))
        mosaic = [r[0] for r in self.db.all("""
            SELECT t.album_id FROM playlist_tracks e JOIN tracks t ON t.id = e.track_id
            WHERE e.playlist_id = ? AND t.has_artwork = 1 AND t.missing = 0
            GROUP BY t.album_id ORDER BY MIN(e.position) LIMIT 4""", (playlist_id,))]
        return {"tracks": row[0], "duration": round(row[1], 1), "mosaic": mosaic}

    def _summary(self, row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"] or "",
            "folder": row["folder"] or "",
            "visibility": row["visibility"],
            "cover": row["cover"],
            "smart": bool(row["rules"]),
            "rules": loads(row["rules"]) if row["rules"] else None,
            "owner": row["owner"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "pinned": bool(row["pinned"]) if "pinned" in row.keys() else False,
            "collaborative": False,
        }

    def _owned(self, user: str, playlist_id: str):
        return self.db.one("SELECT * FROM playlists WHERE id = ? AND owner = ?", (playlist_id, user))

    # ---------- writing ----------

    def create(self, user: str, name, description="", folder="", visibility="private", rules=None,
               track_ids=None) -> dict:
        name = _name(name)
        rules_text = dumps(validate_rules(rules)) if rules else None
        playlist_id = secrets.token_hex(8)
        stamp = now()
        self.db.execute("INSERT INTO playlists (id, owner, name, description, folder, visibility, rules, "
                        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (playlist_id, user, name, _description(description), _folder(folder),
                         _visibility(visibility), rules_text, stamp, stamp))
        if track_ids and not rules_text:
            self.add(user, playlist_id, track_ids, allow_duplicates=True)
        return self.get(user, playlist_id)

    def update(self, user: str, playlist_id: str, changes: dict) -> dict:
        row = self._owned(user, playlist_id)
        if row is None:
            return None
        fields = {}
        if "name" in changes:
            fields["name"] = _name(changes["name"])
        if "description" in changes:
            fields["description"] = _description(changes["description"])
        if "folder" in changes:
            fields["folder"] = _folder(changes["folder"])
        if "visibility" in changes:
            fields["visibility"] = _visibility(changes["visibility"])
        if "rules" in changes:
            if not row["rules"]:
                raise PlaylistError("a regular playlist cannot become a smart playlist")
            fields["rules"] = dumps(validate_rules(changes["rules"]))
        if "cover" in changes:
            cover = changes["cover"]
            if cover is not None and not (isinstance(cover, str) and re.fullmatch(r"(album|upload):[0-9a-f]{8,32}", cover)):
                raise PlaylistError("'cover' must be null, album:<id> or upload:<id>")
            fields["cover"] = cover
        if fields:
            fields["updated_at"] = now()
            assignments = ", ".join(f"{key} = ?" for key in fields)
            self.db.execute(f"UPDATE playlists SET {assignments} WHERE id = ?", [*fields.values(), playlist_id])
        return self.get(user, playlist_id)

    def delete(self, user: str, playlist_id: str) -> bool:
        removed = self.db.execute("DELETE FROM playlists WHERE id = ? AND owner = ?", (playlist_id, user))
        self.db.execute("DELETE FROM pins WHERE user = ? AND kind = 'playlist' AND item_id = ?", (user, playlist_id))
        return bool(removed)

    def add(self, user: str, playlist_id: str, track_ids: list, allow_duplicates=False, position=None) -> dict:
        row = self._regular(user, playlist_id)
        ids = _ids(track_ids)
        known = {track["id"] for track in self.catalog.tracks_by_ids(ids)}
        present = {r[0] for r in self.db.all("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?", (row["id"],))}
        duplicates = [track_id for track_id in ids if track_id in present]
        unknown = [track_id for track_id in ids if track_id not in known]
        adding = [track_id for track_id in ids if track_id in known and (allow_duplicates or track_id not in present)]
        if not allow_duplicates:
            adding = list(dict.fromkeys(adding))
        count = self.db.value("SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,), 0)
        if count + len(adding) > MAX_TRACKS:
            raise PlaylistError(f"a playlist holds at most {MAX_TRACKS} tracks")

        with self.db.transaction() as connection:
            if position is None or position >= count:
                start = count
            else:
                start = max(int(position), 0)
                connection.execute("UPDATE playlist_tracks SET position = position + ? WHERE playlist_id = ? "
                                   "AND position >= ?", (len(adding), playlist_id, start))
            stamp = now()
            for offset, track_id in enumerate(adding):
                connection.execute("INSERT INTO playlist_tracks (entry_id, playlist_id, track_id, position, added_at) "
                                   "VALUES (?, ?, ?, ?, ?)", (secrets.token_hex(8), playlist_id, track_id,
                                                              start + offset, stamp))
            connection.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (stamp, playlist_id))
        return {"added": len(adding), "duplicates": duplicates, "unknown": unknown,
                "playlist": self.get(user, playlist_id)}

    def remove(self, user: str, playlist_id: str, entry_ids: list) -> dict:
        self._regular(user, playlist_id)
        with self.db.transaction() as connection:
            for entry_id in _ids(entry_ids):
                connection.execute("DELETE FROM playlist_tracks WHERE playlist_id = ? AND entry_id = ?",
                                   (playlist_id, entry_id))
            self._renumber(connection, playlist_id)
        return self.get(user, playlist_id)

    def move(self, user: str, playlist_id: str, entry_id: str, to_index: int) -> dict:
        self._regular(user, playlist_id)
        order = [r[0] for r in self.db.all("SELECT entry_id FROM playlist_tracks WHERE playlist_id = ? "
                                           "ORDER BY position", (playlist_id,))]
        if entry_id not in order:
            raise PlaylistError("that entry is not in this playlist")
        order.remove(entry_id)
        order.insert(max(0, min(int(to_index), len(order))), entry_id)
        self._reorder(playlist_id, order)
        return self.get(user, playlist_id)

    def reorder(self, user: str, playlist_id: str, entry_ids: list) -> dict:
        self._regular(user, playlist_id)
        current = [r[0] for r in self.db.all("SELECT entry_id FROM playlist_tracks WHERE playlist_id = ?",
                                             (playlist_id,))]
        if sorted(current) != sorted(_ids(entry_ids)):
            raise PlaylistError("the new order must list every entry exactly once")
        self._reorder(playlist_id, _ids(entry_ids))
        return self.get(user, playlist_id)

    def _reorder(self, playlist_id: str, order: list):
        with self.db.transaction() as connection:
            for position, entry_id in enumerate(order):
                connection.execute("UPDATE playlist_tracks SET position = ? WHERE entry_id = ?", (position, entry_id))
            connection.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (now(), playlist_id))

    def _renumber(self, connection, playlist_id: str):
        order = [r[0] for r in connection.execute("SELECT entry_id FROM playlist_tracks WHERE playlist_id = ? "
                                                  "ORDER BY position", (playlist_id,)).fetchall()]
        for position, entry_id in enumerate(order):
            connection.execute("UPDATE playlist_tracks SET position = ? WHERE entry_id = ?", (position, entry_id))
        connection.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (now(), playlist_id))

    def _regular(self, user: str, playlist_id: str):
        row = self._owned(user, playlist_id)
        if row is None:
            raise LookupError("unknown playlist")
        if row["rules"]:
            raise PlaylistError("a smart playlist is filled by its rules")
        return row

    # ---------- smart playlists ----------

    def _smart_tracks(self, user: str, rules: dict) -> list:
        sql, params = compile_rules(rules, user)
        return [track_payload(row) for row in self.db.all(sql, params)]

    def preview(self, user: str, rules: dict) -> list:
        return self._smart_tracks(user, validate_rules(rules))

    # ---------- import and export ----------

    def export_m3u(self, user: str, playlist_id: str):
        playlist = self.get(user, playlist_id)
        if playlist is None:
            return None
        lines = ["#EXTM3U", f"#PLAYLIST:{_one_line(playlist['name'])}"]
        for entry in playlist["tracks"]:
            if entry.get("missing"):
                continue
            artist = _one_line(entry.get("artist") or entry.get("album_artist") or "")
            lines.append(f"#EXTINF:{int(entry.get('duration') or -1)},{artist} - {_one_line(entry.get('title') or '')}")
            if entry.get("album"):
                lines.append(f"#EXTALB:{_one_line(entry['album'])}")
            # relative to the library folder, so the export never reveals where that is
            lines.append(f"{entry['folder']}/{entry['filename']}" if entry.get("folder") else entry["filename"])
        return "\n".join(lines) + "\n"

    def import_m3u(self, user: str, name: str, content: str) -> dict:
        entries = parse_m3u(content)
        if not name:
            name = next((entry["playlist"] for entry in entries if entry.get("playlist")), None) or "Imported playlist"
        return self.import_entries(user, name, entries)

    def import_entries(self, user: str, name: str, entries: list, description: str = "") -> dict:
        """Matches foreign entries (a path, or title/artist/album/isrc) against this library only."""
        if not isinstance(entries, list) or len(entries) > MAX_TRACKS:
            raise PlaylistError(f"an import may hold at most {MAX_TRACKS} entries")
        matched, unmatched = [], []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            track_id = self.match(entry)
            if track_id:
                matched.append(track_id)
            else:
                unmatched.append({key: str(entry.get(key) or "")[:200] for key in ("title", "artist", "album", "path")})
        playlist = self.create(user, name, description=description)
        if matched:
            self.add(user, playlist["id"], matched, allow_duplicates=True)
        return {"playlist": self.get(user, playlist["id"]), "matched": len(matched), "unmatched": unmatched}

    def match(self, entry: dict):
        isrc = str(entry.get("isrc") or "").strip().upper()
        if isrc:
            found = self.db.value(f"SELECT id FROM tracks t WHERE {VISIBLE} AND upper(isrc) = ? LIMIT 1", (isrc,))
            if found:
                return found
        path = str(entry.get("path") or "").strip()
        if path:
            found = self._match_path(path)
            if found:
                return found
        title = grouping.normalize(entry.get("title"))
        if not title:
            return None
        artist = grouping.normalize(entry.get("artist"))
        album = grouping.normalize(entry.get("album"))
        best, best_score = None, 0
        for row in self.db.all(f"SELECT t.id, t.title, t.artist, t.album_artist, t.album, t.duration FROM tracks t "
                               f"JOIN track_search s ON s.rowid = t.rowid WHERE {VISIBLE} AND track_search MATCH ? "
                               f"LIMIT 50", (_fts_phrase(title),)):
            if grouping.normalize(row["title"]) != title:
                continue
            score = 1
            if artist and artist in (grouping.normalize(row["artist"]), grouping.normalize(row["album_artist"])):
                score += 2
            elif artist:
                continue
            if album and album == grouping.normalize(row["album"]):
                score += 1
            if score > best_score:
                best, best_score = row["id"], score
        return best

    def _match_path(self, path: str):
        windows = "\\" in path
        parts = (PureWindowsPath(path) if windows else PurePosixPath(path)).parts
        if not parts:
            return None
        exact = self.db.value(f"SELECT id FROM tracks t WHERE {VISIBLE} AND path = ?", (path,))
        if exact:
            return exact
        name = parts[-1]
        folder = "/".join(part for part in parts[:-1] if part not in ("..", ".") and not part.endswith((":\\", "/")))
        for row in self.db.all(f"SELECT id, folder FROM tracks t WHERE {VISIBLE} AND filename = ?", (name,)):
            if not folder or folder.endswith(row["folder"] or "") or (row["folder"] or "").endswith(folder):
                return row["id"]
        return None


def parse_m3u(content: str) -> list:
    entries, pending = [], {}
    playlist = None
    for raw in str(content or "").splitlines()[:MAX_TRACKS * 3]:
        line = raw.strip().lstrip("﻿")
        if not line:
            continue
        if line.startswith("#PLAYLIST:"):
            playlist = line[len("#PLAYLIST:"):].strip()[:MAX_NAME]
        elif line.startswith("#EXTINF:"):
            _, _, rest = line.partition(",")
            artist, separator, title = rest.partition(" - ")
            pending = {"title": title.strip(), "artist": artist.strip()} if separator else {"title": rest.strip()}
        elif line.startswith("#EXTALB:"):
            pending["album"] = line[len("#EXTALB:"):].strip()
        elif line.startswith("#"):
            continue
        else:
            if re.match(r"^[a-z][a-z0-9+.-]*://", line, re.IGNORECASE):
                entries.append({**pending})
            else:
                entries.append({**pending, "path": line})
            pending = {}
    if entries and playlist:
        entries[0]["playlist"] = playlist
    return entries


def validate_rules(rules) -> dict:
    if not isinstance(rules, dict):
        raise PlaylistError("smart playlist rules must be an object")
    conditions = rules.get("rules")
    if not isinstance(conditions, list) or not conditions or len(conditions) > 25:
        raise PlaylistError("a smart playlist needs between 1 and 25 rules")
    cleaned = []
    for condition in conditions:
        if not isinstance(condition, dict) or condition.get("field") not in RULE_FIELDS:
            raise PlaylistError(f"unknown rule field; use one of {', '.join(RULE_FIELDS)}")
        kind = RULE_FIELDS[condition["field"]][1]
        operator = condition.get("op")
        allowed = {"text": ("is", "is_not", "contains", "not_contains", "starts_with"),
                   "number": ("is", "is_not", "gt", "lt", "between"),
                   "bool": ("is",), "date": ("in_last_days", "not_in_last_days", "before", "after")}[kind]
        if operator not in allowed:
            raise PlaylistError(f"'{condition['field']}' supports {', '.join(allowed)}")
        value = condition.get("value")
        if kind == "number":
            values = value if operator == "between" else [value]
            if not isinstance(values, list) or len(values) != (2 if operator == "between" else 1):
                raise PlaylistError("'between' needs two numbers")
            try:
                values = [float(item) for item in values]
            except (TypeError, ValueError):
                raise PlaylistError(f"'{condition['field']}' needs a number")
            value = values if operator == "between" else values[0]
        elif kind == "bool":
            value = bool(value)
        elif operator in ("in_last_days", "not_in_last_days"):
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise PlaylistError("a day count must be a whole number")
        else:
            value = str(value or "")[:200]
        cleaned.append({"field": condition["field"], "op": operator, "value": value})
    sort = rules.get("sort", "added")
    if sort not in RULE_SORTS:
        raise PlaylistError(f"sort must be one of {', '.join(RULE_SORTS)}")
    try:
        limit = int(rules.get("limit") or 500)
    except (TypeError, ValueError):
        raise PlaylistError("limit must be a number")
    return {"match": "any" if rules.get("match") == "any" else "all", "rules": cleaned, "sort": sort,
            "order": "asc" if rules.get("order") == "asc" else "desc", "limit": max(1, min(limit, 2000))}


def compile_rules(rules: dict, user: str) -> tuple:
    """Rules to SQL. Columns come from RULE_FIELDS only; every value is a bound parameter."""
    params = {"user": user}
    clauses = []
    for index, condition in enumerate(rules["rules"]):
        column, kind = RULE_FIELDS[condition["field"]]
        name = f"v{index}"
        operator, value = condition["op"], condition["value"]
        if kind == "text":
            params[name] = value
            clause = {
                "is": f"{column} = :{name} COLLATE NOCASE",
                "is_not": f"COALESCE({column}, '') != :{name} COLLATE NOCASE",
                "contains": f"{column} LIKE '%' || :{name} || '%'",
                "not_contains": f"COALESCE({column}, '') NOT LIKE '%' || :{name} || '%'",
                "starts_with": f"{column} LIKE :{name} || '%'",
            }[operator]
        elif kind == "number":
            if operator == "between":
                params[f"{name}a"], params[f"{name}b"] = value
                clause = f"{column} BETWEEN :{name}a AND :{name}b"
            else:
                params[name] = value
                clause = {"is": f"{column} = :{name}", "is_not": f"{column} != :{name}", "gt": f"{column} > :{name}",
                          "lt": f"{column} < :{name}"}[operator]
        elif kind == "bool":
            clause = f"({column}) = {1 if value else 0}" if "EXISTS" not in column else (
                column if value else f"NOT {column}")
        else:
            if operator in ("in_last_days", "not_in_last_days"):
                params[name] = f"-{int(value)} days"
                clause = f"{column} >= strftime('%Y-%m-%dT%H:%M:%S', 'now', :{name})"
                if operator == "not_in_last_days":
                    clause = f"({column} IS NULL OR NOT ({clause}))"
            else:
                params[name] = value
                clause = f"{column} {'<' if operator == 'before' else '>'} :{name}"
        clauses.append(f"({clause})")
    joiner = " OR " if rules["match"] == "any" else " AND "
    direction = "ASC" if rules["order"] == "asc" else "DESC"
    order = RULE_SORTS[rules["sort"]] + ("" if rules["sort"] == "random" else f" {direction}")
    sql = (f"SELECT t.* FROM tracks t WHERE {VISIBLE} AND ({joiner.join(clauses)}) "
           f"ORDER BY {order} LIMIT {int(rules['limit'])}")
    return sql, params


def _mosaic(tracks: list) -> list:
    albums = []
    for track in tracks:
        if track.get("has_artwork") and track.get("album_id") and track["album_id"] not in albums:
            albums.append(track["album_id"])
        if len(albums) == 4:
            break
    return albums


def _fts_phrase(text: str) -> str:
    return '"' + text.replace('"', " ") + '"'


def _one_line(text: str) -> str:
    return re.sub(r"[\r\n]+", " ", str(text))


def _ids(values) -> list:
    if not isinstance(values, list) or len(values) > MAX_TRACKS:
        raise PlaylistError("expected a list of identifiers")
    return [str(value) for value in values if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8,64}", value)]


def _name(value) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise PlaylistError("a playlist needs a name")
    return text[:MAX_NAME]


def _description(value) -> str:
    return str(value or "").strip()[:MAX_DESCRIPTION]


def _folder(value) -> str:
    return " ".join(str(value or "").replace("/", " ").split())[:MAX_NAME]


def _visibility(value) -> str:
    if value not in VISIBILITIES:
        raise PlaylistError("visibility must be private or public")
    return value
