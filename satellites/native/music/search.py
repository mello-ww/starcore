"""Search across tracks, albums, artists and playlists: prefix matching first, typo tolerance after."""

import difflib
import re

from . import grouping
from .catalog import QUALITY_FILTERS, VISIBLE, track_payload

MAX_QUERY = 100
FUZZY_TITLE_LIMIT = 30_000


def _tokens(query: str) -> list:
    return [token for token in re.findall(r"\w+", grouping.normalize(query)) if token][:8]


def fts_query(query: str) -> str:
    return " ".join(f'"{token}"*' for token in _tokens(query))


class Search:
    def __init__(self, db, catalog, playlists):
        self.db = db
        self.catalog = catalog
        self.playlists = playlists
        self._name_cache = None

    def search(self, user: str, query: str, kinds=None, genre=None, quality=None, limit: int = 20) -> dict:
        query = str(query or "").strip()[:MAX_QUERY]
        kinds = set(kinds or ("tracks", "albums", "artists", "playlists", "genres"))
        limit = max(1, min(int(limit or 20), 100))
        empty = {"query": query, "top": None, "tracks": [], "albums": [], "artists": [], "playlists": [],
                 "genres": [], "corrected": None}
        if not _tokens(query):
            return empty

        ids = self._match_ids(query, genre, quality, limit * 10)
        corrected = None
        if not ids:
            corrected = self._correction(query)
            if corrected:
                ids = self._match_ids(corrected, genre, quality, limit * 10)

        result = dict(empty, corrected=corrected)
        effective = corrected or query
        tracks = self.catalog.tracks_by_ids(ids)
        if "tracks" in kinds:
            result["tracks"] = _rank(tracks, effective)[:limit]
        if "albums" in kinds:
            result["albums"] = self._albums(effective, tracks)[:limit]
        if "artists" in kinds:
            result["artists"] = self._artists(effective)[:limit]
        if "playlists" in kinds:
            needle = grouping.normalize(effective)
            result["playlists"] = [playlist for playlist in self.playlists.list(user)
                                   if needle in grouping.normalize(playlist["name"])][:limit]
        if "genres" in kinds:
            needle = grouping.normalize(effective)
            result["genres"] = [genre_entry for genre_entry in self.catalog.genres()
                                if needle in grouping.normalize(genre_entry["name"])][:limit]
        result["top"] = _top(result, effective)
        return result

    def _match_ids(self, query: str, genre, quality, limit: int) -> list:
        expression = fts_query(query)
        if not expression:
            return []
        where, params = [VISIBLE, "track_search MATCH ?"], [expression]
        if genre:
            where.append("t.genre = ? COLLATE NOCASE")
            params.append(genre)
        if quality in QUALITY_FILTERS:
            where.append(QUALITY_FILTERS[quality])
        params.append(limit)
        try:
            rows = self.db.all(f"SELECT t.id FROM track_search s JOIN tracks t ON t.rowid = s.rowid "
                               f"WHERE {' AND '.join(where)} ORDER BY bm25(track_search, 0, 10, 6, 4, 4, 2, 2, 1) "
                               f"LIMIT ?", params)
        except Exception:
            return []
        return [row[0] for row in rows]

    def _albums(self, query: str, tracks: list) -> list:
        needle = grouping.normalize(query)
        ordered = []
        for track in tracks:
            if track["album_id"] not in ordered and (needle in grouping.normalize(track["album"])
                                                     or needle in grouping.normalize(track["album_artist"])):
                ordered.append(track["album_id"])
        return self.catalog.albums_by_id(ordered)

    def _artists(self, query: str) -> list:
        needle = grouping.normalize(query)
        tokens = needle.split()
        if not tokens:
            return []
        # normalized tokens are word characters only, so "_" is the one LIKE wildcard to escape
        clauses = " AND ".join("name LIKE ? ESCAPE '!'" for _ in tokens)
        params = ["%" + token.replace("!", "!!").replace("_", "!_") + "%" for token in tokens]
        expression = "{artists album_artist} : (" + " ".join(f'"{token}"*' for token in tokens) + ")"
        try:
            candidates = [row[0] for row in self.db.all(
                "SELECT DISTINCT ta.artist_id FROM (SELECT rowid FROM track_search WHERE track_search MATCH ? LIMIT 2000) s "
                "JOIN tracks t ON t.rowid = s.rowid JOIN track_artists ta ON ta.track_id = t.id "
                "WHERE ta.role IN ('primary', 'featured', 'album') LIMIT 300", (expression,))]
        except Exception:
            candidates = [row[0] for row in self.db.all(
                f"SELECT DISTINCT artist_id FROM track_artists WHERE role IN ('primary', 'featured', 'album') "
                f"AND {clauses} LIMIT 200", params)]
        matches = []
        for artist in self.catalog.artists_by_id(candidates):
            name = grouping.normalize(artist["name"])
            if all(token in name for token in tokens):
                matches.append((0 if name.startswith(needle) else 1, -artist["tracks"], artist))
        matches.sort(key=lambda item: (item[0], item[1]))
        return [artist for _, _, artist in matches]

    def _correction(self, query: str):
        """The closest real name in the library, for a query that matched nothing."""
        folded = self._names()
        close = difflib.get_close_matches(grouping.normalize(query), list(folded), n=1, cutoff=0.72)
        return folded[close[0]] if close else None

    def _names(self) -> dict:
        version = self.db.value("SELECT COUNT(*) || ':' || COALESCE(MAX(indexed_at), '') || ':' || "
                                "SUM(missing + hidden) FROM tracks")
        if self._name_cache and self._name_cache[0] == version:
            return self._name_cache[1]
        names = [row[0] for row in self.db.all(
            "SELECT DISTINCT ta.name FROM track_artists ta JOIN tracks t ON t.id = ta.track_id "
            f"WHERE {VISIBLE} UNION SELECT DISTINCT album FROM tracks t WHERE {VISIBLE} AND album IS NOT NULL")]
        if self.catalog.count() <= FUZZY_TITLE_LIMIT:
            names += [row[0] for row in self.db.all(f"SELECT DISTINCT title FROM tracks t WHERE {VISIBLE}")]
        folded = {grouping.normalize(name): name for name in names if name}
        self._name_cache = (version, folded)
        return folded

    def suggest(self, user: str, query: str, limit: int = 8) -> list:
        prefix = grouping.normalize(query)
        if not prefix:
            return []
        suggestions = []
        for row in self.db.all(f"""
                SELECT name, kind FROM (
                    SELECT DISTINCT ta.name AS name, 'artist' AS kind FROM track_artists ta
                    JOIN tracks t ON t.id = ta.track_id WHERE {VISIBLE} AND ta.role IN ('primary', 'album')
                    UNION SELECT DISTINCT album, 'album' FROM tracks t WHERE {VISIBLE} AND album IS NOT NULL
                    UNION SELECT DISTINCT genre, 'genre' FROM tracks t WHERE {VISIBLE} AND genre IS NOT NULL)
                WHERE name LIKE ? COLLATE NOCASE LIMIT ?""", (f"{query.strip()[:MAX_QUERY]}%", limit)):
            suggestions.append({"text": row[0], "kind": row[1]})
        if len(suggestions) < limit:
            for row in self.db.all(f"SELECT t.* FROM track_search s JOIN tracks t ON t.rowid = s.rowid "
                                   f"WHERE {VISIBLE} AND track_search MATCH ? LIMIT ?",
                                   (fts_query(query), limit - len(suggestions))):
                suggestions.append({"text": row["title"], "kind": "track", "id": row["id"],
                                    "subtitle": row["artist"] or row["album_artist"]})
        return suggestions


def _rank(tracks: list, query: str) -> list:
    needle = grouping.normalize(query)

    def score(track):
        title = grouping.normalize(track["title"])
        exact = title == needle
        starts = title.startswith(needle)
        return (0 if exact else 1 if starts else 2, -(track["quality"]["tier"]))

    return sorted(tracks, key=score)


def _top(result: dict, query: str):
    needle = grouping.normalize(query)
    for artist in result["artists"]:
        if grouping.normalize(artist["name"]) == needle:
            return {"kind": "artist", "item": artist}
    for album in result["albums"]:
        if grouping.normalize(album["album"]) == needle:
            return {"kind": "album", "item": album}
    if result["tracks"]:
        return {"kind": "track", "item": result["tracks"][0]}
    if result["artists"]:
        return {"kind": "artist", "item": result["artists"][0]}
    if result["albums"]:
        return {"kind": "album", "item": result["albums"][0]}
    return None


__all__ = ["Search", "fts_query", "track_payload"]
