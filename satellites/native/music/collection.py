"""What a listener keeps: liked tracks, albums, followed artists, pinned items, recent searches."""

from .db import now

KINDS = ("track", "album", "artist", "playlist")
PIN_LIMIT = 12
RECENT_SEARCHES = 20


class CollectionError(ValueError):
    pass


class Collection:
    def __init__(self, db, catalog):
        self.db = db
        self.catalog = catalog

    def set_favorite(self, user: str, kind: str, item_ids: list, liked: bool) -> dict:
        _kind(kind)
        stamp = now()
        for item_id in _items(item_ids):
            if liked:
                self.db.execute("INSERT OR IGNORE INTO favorites (user, kind, item_id, created_at) VALUES (?, ?, ?, ?)",
                                (user, kind, item_id, stamp))
            else:
                self.db.execute("DELETE FROM favorites WHERE user = ? AND kind = ? AND item_id = ?",
                                (user, kind, item_id))
        return self.favorite_ids(user)

    def favorite_ids(self, user: str) -> dict:
        ids = {kind: [] for kind in KINDS}
        for row in self.db.all("SELECT kind, item_id FROM favorites WHERE user = ? ORDER BY created_at DESC", (user,)):
            ids.setdefault(row["kind"], []).append(row["item_id"])
        return ids

    def liked_tracks(self, user: str) -> list:
        rows = self.db.all("SELECT item_id, created_at FROM favorites WHERE user = ? AND kind = 'track' "
                           "ORDER BY created_at DESC", (user,))
        liked_at = {row["item_id"]: row["created_at"] for row in rows}
        tracks = self.catalog.tracks_by_ids(list(liked_at))
        for track in tracks:
            track["liked_at"] = liked_at[track["id"]]
        return tracks

    def favorites(self, user: str) -> dict:
        ids = self.favorite_ids(user)
        albums = {album["id"]: album for album in self.catalog.albums()}
        artists = {artist["id"]: artist for artist in self.catalog.artists(include_featured=True)}
        return {
            "tracks": self.liked_tracks(user),
            "albums": [albums[item] for item in ids["album"] if item in albums],
            "artists": [artists[item] for item in ids["artist"] if item in artists],
            "playlists": ids["playlist"],
            "ids": ids,
        }

    def is_favorite(self, user: str, kind: str, item_id: str) -> bool:
        return bool(self.db.one("SELECT 1 FROM favorites WHERE user = ? AND kind = ? AND item_id = ?",
                                (user, kind, item_id)))

    def set_pin(self, user: str, kind: str, item_id: str, pinned: bool) -> list:
        _kind(kind)
        if pinned:
            count = self.db.value("SELECT COUNT(*) FROM pins WHERE user = ?", (user,), 0)
            if count >= PIN_LIMIT:
                raise CollectionError(f"at most {PIN_LIMIT} items can be pinned")
            self.db.execute("INSERT OR IGNORE INTO pins (user, kind, item_id, created_at) VALUES (?, ?, ?, ?)",
                            (user, kind, str(item_id)[:64], now()))
        else:
            self.db.execute("DELETE FROM pins WHERE user = ? AND kind = ? AND item_id = ?", (user, kind, item_id))
        return self.pins(user)

    def pins(self, user: str) -> list:
        return [{"kind": row["kind"], "id": row["item_id"]} for row in self.db.all(
            "SELECT kind, item_id FROM pins WHERE user = ? ORDER BY created_at", (user,))]

    def remember_search(self, user: str, query: str):
        query = " ".join(str(query or "").split())[:100]
        if len(query) < 2:
            return
        self.db.execute("INSERT INTO searches (user, query, searched_at) VALUES (?, ?, ?) ON CONFLICT (user, query) "
                        "DO UPDATE SET searched_at = excluded.searched_at", (user, query, now()))
        self.db.execute("DELETE FROM searches WHERE user = ? AND query NOT IN (SELECT query FROM searches WHERE "
                        "user = ? ORDER BY searched_at DESC LIMIT ?)", (user, user, RECENT_SEARCHES))

    def recent_searches(self, user: str) -> list:
        return [row[0] for row in self.db.all("SELECT query FROM searches WHERE user = ? ORDER BY searched_at DESC",
                                              (user,))]

    def clear_searches(self, user: str):
        self.db.execute("DELETE FROM searches WHERE user = ?", (user,))


def _kind(kind: str):
    if kind not in KINDS:
        raise CollectionError(f"kind must be one of {', '.join(KINDS)}")


def _items(values) -> list:
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list) or len(values) > 5000:
        raise CollectionError("expected one identifier or a list of them")
    return [str(value)[:64] for value in values if isinstance(value, str) and value]
