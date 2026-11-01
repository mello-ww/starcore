"""Listening history, and the statistics and yearly Wrapped built from it. Never leaves the server."""

from datetime import datetime, timedelta, timezone
import re

from .db import now

# the scrobbling convention: half the track, or four minutes, whichever comes first
PLAY_FRACTION = 0.5
PLAY_CAP = 240
SKIP_BEFORE = 30
CONTEXT = re.compile(r"^(album|artist|playlist|genre|mix|radio|search|library|liked|folder|queue):[\w:.-]{0,80}$")


class History:
    def __init__(self, db, catalog):
        self.db = db
        self.catalog = catalog

    def record(self, user: str, track_id: str, seconds: float, device: str = None, context: str = None,
               played_at: str = None) -> dict:
        row = self.catalog.track_row(track_id)
        if row is None:
            raise LookupError("unknown track")
        seconds = max(0.0, min(float(seconds or 0), 24 * 3600))
        duration = row["duration"] or 0
        threshold = min(duration * PLAY_FRACTION, PLAY_CAP) if duration else PLAY_CAP
        completed = seconds >= threshold
        skipped = not completed and seconds < SKIP_BEFORE
        context = context if isinstance(context, str) and CONTEXT.match(context) else None
        self.db.execute("INSERT INTO plays (user, track_id, played_at, seconds, completed, skipped, device, context) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (user, track_id, played_at or now(), round(seconds, 1), int(completed), int(skipped),
                         str(device or "")[:64] or None, context))
        return {"counted": completed, "skipped": skipped}

    def clear(self, user: str, before: str = None) -> int:
        if before:
            return self.db.execute("DELETE FROM plays WHERE user = ? AND played_at < ?", (user, before))
        return self.db.execute("DELETE FROM plays WHERE user = ?", (user,))

    def recent(self, user: str, limit: int = 50) -> list:
        rows = self.db.all("SELECT track_id, MAX(played_at) AS last FROM plays WHERE user = ? AND skipped = 0 "
                           "GROUP BY track_id ORDER BY last DESC LIMIT ?", (user, int(limit)))
        tracks = {track["id"]: track for track in self.catalog.tracks_by_ids([row[0] for row in rows])}
        return [{**tracks[row[0]], "played_at": row[1]} for row in rows if row[0] in tracks]

    def recent_contexts(self, user: str, limit: int = 12) -> list:
        rows = self.db.all("SELECT context, MAX(played_at) AS last FROM plays WHERE user = ? AND context IS NOT NULL "
                           "AND context NOT LIKE 'search:%' AND context NOT LIKE 'queue:%' "
                           "GROUP BY context ORDER BY last DESC LIMIT ?", (user, int(limit)))
        return [{"context": row[0], "played_at": row[1]} for row in rows]

    def play_counts(self, user: str, since: str = None) -> dict:
        sql = "SELECT track_id, COUNT(*) FROM plays WHERE user = ? AND completed = 1"
        params = [user]
        if since:
            sql += " AND played_at >= ?"
            params.append(since)
        return {row[0]: row[1] for row in self.db.all(sql + " GROUP BY track_id", params)}

    def last_played(self, user: str) -> dict:
        return {row[0]: row[1] for row in self.db.all(
            "SELECT track_id, MAX(played_at) FROM plays WHERE user = ? AND completed = 1 GROUP BY track_id", (user,))}

    def skip_counts(self, user: str) -> dict:
        return {row[0]: row[1] for row in self.db.all(
            "SELECT track_id, COUNT(*) FROM plays WHERE user = ? AND skipped = 1 GROUP BY track_id", (user,))}

    # ---------- statistics ----------

    def stats(self, user: str, start: str = None, end: str = None, limit: int = 10) -> dict:
        where, params = ["p.user = ?", "p.completed = 1"], [user]
        if start:
            where.append("p.played_at >= ?")
            params.append(start)
        if end:
            where.append("p.played_at < ?")
            params.append(end)
        condition = " AND ".join(where)
        totals = self.db.one(f"SELECT COUNT(*), COALESCE(SUM(p.seconds), 0), COUNT(DISTINCT p.track_id), "
                             f"MIN(p.played_at) FROM plays p WHERE {condition}", params)

        def top(column: str, join: str = "", extra: str = ""):
            return self.db.all(f"SELECT {column} AS key, COUNT(*) AS plays, SUM(p.seconds) AS seconds FROM plays p "
                               f"JOIN tracks t ON t.id = p.track_id {join} WHERE {condition} {extra} "
                               f"GROUP BY key ORDER BY plays DESC, seconds DESC LIMIT ?", [*params, limit])

        top_tracks = top("t.id")
        tracks = {track["id"]: track for track in self.catalog.tracks_by_ids([row[0] for row in top_tracks],
                                                                              include_missing=True)}
        top_artists = top("ta.artist_id", "JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'primary'")
        artist_names = {row[0]: row[1] for row in self.db.all(
            "SELECT artist_id, MIN(name) FROM track_artists GROUP BY artist_id")} if top_artists else {}
        top_albums = top("t.album_id")
        albums = {row["album_id"]: row for row in self.db.all(
            "SELECT album_id, MIN(album) AS album, MIN(album_artist) AS artist FROM tracks GROUP BY album_id")} \
            if top_albums else {}
        top_genres = top("t.genre", extra="AND t.genre IS NOT NULL")
        hours = {int(row[0]): row[1] for row in self.db.all(
            f"SELECT strftime('%H', p.played_at), COUNT(*) FROM plays p WHERE {condition} GROUP BY 1", params)}
        days = self.db.all(f"SELECT substr(p.played_at, 1, 10), COUNT(*), SUM(p.seconds) FROM plays p "
                           f"WHERE {condition} GROUP BY 1 ORDER BY 1", params)
        return {
            "plays": totals[0],
            "minutes": round(totals[1] / 60),
            "distinct_tracks": totals[2],
            "first_play": totals[3],
            "top_tracks": [{"track": tracks.get(row[0]), "plays": row[1]} for row in top_tracks if row[0] in tracks],
            "top_artists": [{"id": row[0], "name": artist_names.get(row[0]), "plays": row[1],
                             "minutes": round((row[2] or 0) / 60)} for row in top_artists],
            "top_albums": [{"id": row[0], "album": albums[row[0]]["album"] if row[0] in albums else None,
                            "artist": albums[row[0]]["artist"] if row[0] in albums else None,
                            "plays": row[1]} for row in top_albums],
            "top_genres": [{"name": row[0], "plays": row[1]} for row in top_genres],
            "by_hour": [hours.get(hour, 0) for hour in range(24)],
            "by_day": [{"day": row[0], "plays": row[1], "minutes": round((row[2] or 0) / 60)} for row in days],
        }

    def wrapped(self, user: str, year: int) -> dict:
        start, end = f"{year:04d}-01-01", f"{year + 1:04d}-01-01"
        stats = self.stats(user, start, end, limit=5)
        earlier_artists = {row[0] for row in self.db.all(
            "SELECT DISTINCT ta.artist_id FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id "
            "AND ta.role = 'primary' WHERE p.user = ? AND p.completed = 1 AND p.played_at < ?", (user, start))}
        this_year = self.db.all(
            "SELECT ta.artist_id, MIN(ta.name), MIN(p.played_at) FROM plays p JOIN track_artists ta "
            "ON ta.track_id = p.track_id AND ta.role = 'primary' WHERE p.user = ? AND p.completed = 1 "
            "AND p.played_at >= ? AND p.played_at < ? GROUP BY ta.artist_id ORDER BY 3", (user, start, end))
        discovered = [{"id": row[0], "name": row[1], "first_play": row[2]} for row in this_year
                      if row[0] not in earlier_artists]
        days = sorted({entry["day"] for entry in stats["by_day"]})
        busiest = max(stats["by_day"], key=lambda entry: entry["minutes"], default=None)
        peak_hour = max(range(24), key=lambda hour: stats["by_hour"][hour]) if stats["plays"] else None
        return {
            "year": year,
            **stats,
            "listening_days": len(days),
            "longest_streak": _longest_streak(days),
            "busiest_day": busiest,
            "peak_hour": peak_hour,
            "new_artists": discovered[:10],
            "new_artist_count": len(discovered),
            "personality": _personality(stats, len(discovered)),
        }


def _longest_streak(days: list) -> int:
    best = current = 0
    previous = None
    for day in days:
        date = datetime.strptime(day, "%Y-%m-%d").date()
        current = current + 1 if previous and date - previous == timedelta(days=1) else 1
        best = max(best, current)
        previous = date
    return best


def _personality(stats: dict, new_artists: int) -> str:
    """A plain description of the numbers above; never inferred from anything else."""
    if not stats["plays"]:
        return "No listening recorded this year yet."
    distinct_ratio = stats["distinct_tracks"] / stats["plays"]
    if new_artists >= 20:
        return "Explorer: you found many artists you had never played before."
    if distinct_ratio < 0.25:
        return "Loyalist: you kept coming back to the same favourites."
    if stats["top_genres"] and len(stats["top_genres"]) >= 5:
        return "Eclectic: your listening spread across many genres."
    return "Steady: a balanced mix of favourites and new plays."


def year_now() -> int:
    return datetime.now(timezone.utc).year
