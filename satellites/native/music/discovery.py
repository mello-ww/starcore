"""Home, mixes and radio from this library and this listener's own history.

Everything is computed locally and deterministically: the same listener on the same day
gets the same mixes, every suggestion is a track that exists here, and each carries the
plain reason it was picked. Nothing is sent anywhere.
"""

from datetime import datetime, timedelta, timezone
from threading import Lock
import random
import re
import time

from . import grouping
from .catalog import VISIBLE

MIX_SIZE = 50
DAILY_MIXES = 6
CACHE_SECONDS = 300

MOODS = {
    "Calm": ("ambient", "classical", "new age", "chill", "acoustic", "piano", "lo-fi", "downtempo", "meditative"),
    "Energy": ("rock", "metal", "punk", "hard rock", "drum", "edm", "techno", "trance", "hardcore"),
    "Groove": ("funk", "soul", "r&b", "disco", "house", "hip-hop", "rap", "reggae", "afrobeat"),
    "Focus": ("instrumental", "soundtrack", "post-rock", "minimal", "jazz", "electronic", "idm"),
}


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", grouping.normalize(text)).strip("-")[:40] or "x"


class Discovery:
    def __init__(self, db, catalog, history, collection, playlists):
        self.db = db
        self.catalog = catalog
        self.history = history
        self.collection = collection
        self.playlists = playlists
        self._cache = {}
        self._mix_cache = {}
        self._cache_lock = Lock()

    # ---------- signals ----------

    def _signals(self, user: str) -> dict:
        key = (user, datetime.now(timezone.utc).date().isoformat(),
               self.db.value("SELECT COUNT(*) FROM plays WHERE user = ?", (user,), 0),
               self.db.value("SELECT COUNT(*) FROM favorites WHERE user = ?", (user,), 0),
               self.db.value("SELECT COUNT(*) || ':' || MAX(indexed_at) FROM tracks"))
        with self._cache_lock:
            cached = self._cache.get(user)
            if cached and cached[0] == key and time.monotonic() - cached[1] < CACHE_SECONDS:
                return cached[2]

        rows = self.db.all(f"SELECT id, title, artist_id, album_id, album_artist_id, genre, year, added_at, duration, "
                           f"has_artwork FROM tracks t WHERE {VISIBLE}")
        tracks = {row["id"]: dict(row) for row in rows}
        plays = self.history.play_counts(user)
        recent = self.history.play_counts(user, since=_days_ago(30))
        last = self.history.last_played(user)
        skips = self.history.skip_counts(user)
        liked = set(self.collection.favorite_ids(user)["track"])
        followed = set(self.collection.favorite_ids(user)["artist"])
        names = {row[0]: row[1] for row in self.db.all("SELECT artist_id, MIN(name) FROM track_artists GROUP BY artist_id")}

        artist_affinity, genre_affinity, album_affinity = {}, {}, {}
        for track_id, count in plays.items():
            track = tracks.get(track_id)
            if track is None:
                continue
            weight = count + 2 * recent.get(track_id, 0)
            artist_affinity[track["artist_id"]] = artist_affinity.get(track["artist_id"], 0) + weight
            album_affinity[track["album_id"]] = album_affinity.get(track["album_id"], 0) + weight
            if track["genre"]:
                genre_affinity[track["genre"]] = genre_affinity.get(track["genre"], 0) + weight
        for track_id in liked:
            track = tracks.get(track_id)
            if track:
                artist_affinity[track["artist_id"]] = artist_affinity.get(track["artist_id"], 0) + 5
                if track["genre"]:
                    genre_affinity[track["genre"]] = genre_affinity.get(track["genre"], 0) + 3
        for artist in followed:
            artist_affinity[artist] = artist_affinity.get(artist, 0) + 10

        signals = {"tracks": tracks, "plays": plays, "recent": recent, "last": last, "skips": skips, "liked": liked,
                   "followed": followed, "artists": artist_affinity, "genres": genre_affinity,
                   "albums": album_affinity, "names": names}
        with self._cache_lock:
            self._cache[user] = (key, time.monotonic(), signals)
        return signals

    def _rng(self, user: str, salt: str) -> random.Random:
        return random.Random(f"{user}:{datetime.now(timezone.utc).date().isoformat()}:{salt}")

    def _penalty(self, signals: dict, track_id: str) -> float:
        skips = signals["skips"].get(track_id, 0)
        plays = signals["plays"].get(track_id, 0)
        return 1.0 / (1 + max(0, skips - plays))

    # ---------- mixes ----------

    def mixes(self, user: str) -> list:
        return [{key: value for key, value in mix.items() if key != "ids"} for mix in self._computed(user)]

    def _computed(self, user: str) -> list:
        signals = self._signals(user)
        with self._cache_lock:
            cached = self._mix_cache.get(user)
            if cached and cached[0] is signals:
                return cached[1]
        definitions = []
        for index, (kind, seed, label) in enumerate(self._daily_seeds(user, signals), start=1):
            definitions.append({"id": f"daily-{index}", "name": f"Daily Mix {index}", "kind": "daily",
                                "description": f"{label} and more like it from your library", "seed": seed,
                                "seed_kind": kind})
        if any(count >= 3 for count in signals["recent"].values()):
            definitions.append({"id": "on-repeat", "name": "On Repeat", "kind": "on-repeat",
                                "description": "The songs you've played most over the last 30 days"})
        definitions.append({"id": "rediscover", "name": "Recently Rediscovered", "kind": "rediscover",
                            "description": "Old favourites you haven't played in a while"})
        definitions.append({"id": "forgotten", "name": "Forgotten Favorites", "kind": "forgotten",
                            "description": "Liked songs you haven't heard in three months"})
        definitions.append({"id": "new", "name": "New Additions", "kind": "new",
                            "description": "Added to your library recently and not yet played"})
        if signals["artists"]:
            definitions.append({"id": "favorite-artists", "name": "Favorite Artists Mix", "kind": "favorite-artists",
                                "description": "Your most-played artists, together"})
        for genre in self._top_genres(signals, 6):
            definitions.append({"id": f"genre-{slug(genre)}", "name": f"{genre} Mix", "kind": "genre", "seed": genre,
                                "description": f"{genre} from across your library"})
        mixes = []
        for definition in definitions:
            tracks = self._mix_tracks(user, signals, definition)
            if tracks:
                mixes.append({**definition, "tracks": len(tracks), "mosaic": _mosaic(signals, tracks), "ids": tracks,
                              "duration": round(sum(signals["tracks"][t]["duration"] or 0 for t in tracks), 1)})
        with self._cache_lock:
            self._mix_cache[user] = (signals, mixes)
        return mixes

    def mix(self, user: str, mix_id: str):
        signals = self._signals(user)
        computed = next((entry for entry in self._computed(user) if entry["id"] == mix_id), None)
        if computed is None:
            return None
        ids = computed["ids"]
        definition = {key: value for key, value in computed.items() if key not in ("ids", "tracks", "mosaic", "duration")}
        tracks = self.catalog.tracks_by_ids(ids)
        reasons = self._reasons(signals, definition)
        for track in tracks:
            track["reason"] = reasons(track["id"])
        return {**definition, "tracks": tracks, "mosaic": _mosaic(signals, ids)}

    def _daily_seeds(self, user: str, signals: dict) -> list:
        seeds = []
        for artist_id in sorted(signals["artists"], key=lambda key: -signals["artists"][key])[:DAILY_MIXES]:
            seeds.append(("artist", artist_id, signals["names"].get(artist_id, "An artist you play")))
        if len(seeds) < DAILY_MIXES:
            for genre in self._top_genres(signals, DAILY_MIXES - len(seeds), include_library=True):
                seeds.append(("genre", genre, genre))
        return seeds[:DAILY_MIXES]

    def _top_genres(self, signals: dict, count: int, include_library: bool = False) -> list:
        ranked = sorted(signals["genres"], key=lambda genre: -signals["genres"][genre])
        if include_library or len(ranked) < count:
            library = {}
            for track in signals["tracks"].values():
                if track["genre"]:
                    library[track["genre"]] = library.get(track["genre"], 0) + 1
            ranked += [genre for genre in sorted(library, key=lambda genre: -library[genre]) if genre not in ranked
                       and library[genre] >= 3]
        return ranked[:count]

    def _mix_tracks(self, user: str, signals: dict, definition: dict) -> list:
        tracks, kind = signals["tracks"], definition["kind"]
        rng = self._rng(user, definition["id"])
        if kind == "on-repeat":
            ranked = sorted((tid for tid, count in signals["recent"].items() if count >= 2 and tid in tracks),
                            key=lambda tid: -signals["recent"][tid])
            return ranked[:MIX_SIZE]
        if kind == "rediscover":
            cutoff = _days_ago(60)
            candidates = [tid for tid, count in signals["plays"].items()
                          if count >= 3 and tid in tracks and signals["last"].get(tid, "") < cutoff]
            return _weighted_sample(rng, candidates, lambda tid: signals["plays"][tid], MIX_SIZE)
        if kind == "forgotten":
            cutoff = _days_ago(90)
            candidates = [tid for tid in signals["liked"] if tid in tracks and signals["last"].get(tid, "") < cutoff]
            return _weighted_sample(rng, candidates, lambda tid: 1, MIX_SIZE)
        if kind == "new":
            cutoff = _days_ago(30)
            candidates = sorted((tid for tid, track in tracks.items()
                                 if (track["added_at"] or "") >= cutoff and tid not in signals["plays"]),
                                key=lambda tid: tracks[tid]["added_at"] or "", reverse=True)
            return candidates[:MIX_SIZE]
        if kind == "favorite-artists":
            top = sorted(signals["artists"], key=lambda key: -signals["artists"][key])[:8]
            candidates = [tid for tid, track in tracks.items() if track["artist_id"] in top]
            return _weighted_sample(rng, candidates, lambda tid: (1 + signals["plays"].get(tid, 0))
                                    * self._penalty(signals, tid), MIX_SIZE)
        if kind == "genre":
            candidates = [tid for tid, track in tracks.items()
                          if (track["genre"] or "").lower() == definition["seed"].lower()]
            return _weighted_sample(rng, candidates, lambda tid: (1 + signals["plays"].get(tid, 0) * 0.5
                                                                  + (3 if tid in signals["liked"] else 0))
                                    * self._penalty(signals, tid), MIX_SIZE)
        if kind == "daily":
            return self._seeded(signals, rng, definition["seed_kind"], definition["seed"])
        return []

    def _seeded(self, signals: dict, rng, seed_kind: str, seed: str) -> list:
        """A seed's own tracks first, widened to artists and genres around it."""
        tracks = signals["tracks"]
        if seed_kind == "artist":
            own = [tid for tid, track in tracks.items() if track["artist_id"] == seed or track["album_artist_id"] == seed]
            genres = {tracks[tid]["genre"] for tid in own if tracks[tid]["genre"]}
            similar = {entry["id"] for entry in self.catalog.similar_artists(seed, list(genres), limit=6)}
        else:
            own = [tid for tid, track in tracks.items() if (track["genre"] or "").lower() == seed.lower()]
            genres, similar = {seed}, set()

        def weight(tid):
            track = tracks[tid]
            score = 1.0
            if tid in own:
                score += 3
            if track["artist_id"] in similar:
                score += 2
            score += min(signals["plays"].get(tid, 0), 10) * 0.3
            if tid in signals["liked"]:
                score += 2
            return score * self._penalty(signals, tid)

        pool = set(own) | {tid for tid, track in tracks.items()
                           if track["artist_id"] in similar or (track["genre"] in genres and track["genre"])}
        return _spread(_weighted_sample(rng, list(pool), weight, MIX_SIZE), tracks)

    def _reasons(self, signals: dict, definition: dict):
        tracks, kind = signals["tracks"], definition["kind"]

        def reason(track_id: str) -> str:
            track = tracks.get(track_id) or {}
            if kind == "on-repeat":
                return f"Played {signals['recent'].get(track_id, 0)} times this month"
            if kind == "rediscover":
                return f"You played this {signals['plays'].get(track_id, 0)} times, last on {signals['last'].get(track_id, '')[:10]}"
            if kind == "forgotten":
                return "You liked this and haven't played it in a while"
            if kind == "new":
                return f"Added on {(track.get('added_at') or '')[:10]}"
            if kind == "genre":
                return f"Tagged {track.get('genre')}"
            if kind == "favorite-artists":
                return f"By {signals['names'].get(track.get('artist_id'), 'one of your top artists')}"
            if track_id in signals["liked"]:
                return "A song you liked"
            if definition.get("seed_kind") == "artist" and track.get("artist_id") == definition.get("seed"):
                return f"By {signals['names'].get(definition['seed'])}"
            if track.get("genre"):
                return f"Shares the {track['genre']} genre"
            return "From an artist near your seed"

        return reason

    # ---------- radio ----------

    def radio(self, user: str, kind: str, item: str, size: int = MIX_SIZE) -> dict:
        signals = self._signals(user)
        tracks = signals["tracks"]
        rng = self._rng(user, f"radio:{kind}:{item}:{int(time.time() // 3600)}")
        if kind == "track":
            seed = tracks.get(item)
            if seed is None:
                return None
            ids = self._seeded(signals, rng, "artist", seed["artist_id"])
            if seed["genre"]:
                ids = list(dict.fromkeys(ids + self._seeded(signals, rng, "genre", seed["genre"])))
            ids = [item] + [tid for tid in ids if tid != item]
            name = seed["title"]
        elif kind == "artist":
            if not any(track["artist_id"] == item or track["album_artist_id"] == item for track in tracks.values()):
                return None
            ids = self._seeded(signals, rng, "artist", item)
            name = signals["names"].get(item, "Artist")
        elif kind == "album":
            own = [tid for tid, track in tracks.items() if track["album_id"] == item]
            if not own:
                return None
            artist = tracks[own[0]]["album_artist_id"]
            ids = list(dict.fromkeys(rng.sample(own, min(len(own), 5)) + self._seeded(signals, rng, "artist", artist)))
            name = self.db.value("SELECT album FROM tracks WHERE album_id = ? LIMIT 1", (item,)) or "Album"
        elif kind == "genre":
            ids = self._seeded(signals, rng, "genre", item)
            if not ids:
                return None
            name = item
        else:
            return None
        definition = {"kind": "daily", "seed_kind": "artist" if kind != "genre" else "genre",
                      "seed": tracks[ids[0]]["artist_id"] if ids and kind != "genre" else item}
        result = self.catalog.tracks_by_ids(ids[:size])
        reasons = self._reasons(signals, definition)
        for track in result:
            track["reason"] = reasons(track["id"])
        return {"id": f"radio-{kind}-{item}", "name": f"{name} Radio", "kind": "radio", "tracks": result}

    # ---------- home ----------

    def home(self, user: str, hour: int = None, enabled: bool = True) -> dict:
        signals = self._signals(user)
        hour = datetime.now().hour if hour is None or not 0 <= int(hour) <= 23 else int(hour)
        greeting = "Good morning" if 5 <= hour < 12 else "Good afternoon" if 12 <= hour < 18 else "Good evening"
        sections = []

        def add(section_id, title, kind, items, subtitle=None):
            if items:
                sections.append({"id": section_id, "title": title, "kind": kind, "items": items, "subtitle": subtitle})

        mixes = self.mixes(user) if enabled else []
        add("continue", "Continue listening", "contexts", self._contexts(user))
        add("recent", "Recently played", "tracks", self.history.recent(user, 20))
        if enabled:
            add("mixes", "Made for you", "mixes", [mix for mix in mixes if mix["kind"] == "daily"],
                "Daily Mixes built from what you play")
            add("on-repeat", "Your listening", "mixes", [mix for mix in mixes if mix["kind"] in
                                                         ("on-repeat", "rediscover", "forgotten", "favorite-artists")])
        add("albums", "Your top albums", "albums", self._albums(sorted(
            signals["albums"], key=lambda key: -signals["albums"][key])[:12]))
        add("artists", "Your top artists", "artists", self._artists(sorted(
            signals["artists"], key=lambda key: -signals["artists"][key])[:12], signals))
        add("added", "Recently added", "albums", self.catalog.albums(sort="added", order="desc", limit=16))
        if enabled:
            add("recommended", "Recommended for you", "tracks", self.recommended(user, 20),
                "Songs you haven't played much, near the ones you do")
        add("liked", "Liked songs", "tracks", self.collection.liked_tracks(user)[:20])
        if enabled:
            add("genres", "Genre mixes", "mixes", [mix for mix in mixes if mix["kind"] == "genre"])
        add("moods", "Moods", "moods", self.moods(signals), "Picked from genre tags")
        if not signals["plays"]:
            add("start", "Start listening", "albums", self.catalog.albums(sort="random", limit=12),
                "Play something and this page fills in with your own history")
        return {"greeting": greeting, "sections": sections, "personalized": bool(signals["plays"] or signals["liked"])}

    def recommended(self, user: str, limit: int = 20) -> list:
        signals = self._signals(user)
        if not signals["artists"] and not signals["genres"]:
            return []
        rng = self._rng(user, "recommended")
        top_artists = set(sorted(signals["artists"], key=lambda key: -signals["artists"][key])[:15])
        top_genres = set(sorted(signals["genres"], key=lambda key: -signals["genres"][key])[:5])
        candidates, reasons = [], {}
        for tid, track in signals["tracks"].items():
            if signals["plays"].get(tid, 0) > 1 or tid in signals["liked"]:
                continue
            score = 0
            if track["artist_id"] in top_artists:
                score += 3
                reasons[tid] = f"By {signals['names'].get(track['artist_id'])}, whom you play often"
            if track["genre"] in top_genres:
                score += 1
                reasons.setdefault(tid, f"{track['genre']}, one of your top genres")
            if score:
                candidates.append((tid, score * self._penalty(signals, tid)))
        weights = dict(candidates)
        picked = _spread(_weighted_sample(rng, list(weights), weights.get, limit), signals["tracks"])
        tracks = self.catalog.tracks_by_ids(picked)
        for track in tracks:
            track["reason"] = reasons.get(track["id"])
        return tracks

    def moods(self, signals: dict) -> list:
        counts = {}
        for track in signals["tracks"].values():
            if track["genre"]:
                counts[track["genre"]] = counts.get(track["genre"], 0) + 1
        moods = []
        for name, keywords in MOODS.items():
            genres = sorted(genre for genre in counts if any(keyword in genre.lower() for keyword in keywords))
            count = sum(counts[genre] for genre in genres)
            if count >= 5:
                moods.append({"id": slug(name), "name": name, "genres": genres[:6], "tracks": count})
        return moods

    def mood(self, user: str, mood_id: str):
        signals = self._signals(user)
        entry = next((mood for mood in self.moods(signals) if mood["id"] == mood_id), None)
        if entry is None:
            return None
        rng = self._rng(user, f"mood:{mood_id}")
        ids = [tid for tid, track in signals["tracks"].items() if track["genre"] in entry["genres"]]
        picked = _spread(_weighted_sample(rng, ids, lambda tid: 1 + signals["plays"].get(tid, 0) * 0.2, MIX_SIZE),
                         signals["tracks"])
        tracks = self.catalog.tracks_by_ids(picked)
        for track in tracks:
            track["reason"] = f"Tagged {track['genre']}"
        return {**entry, "tracks": tracks}

    def _contexts(self, user: str) -> list:
        items = []
        for entry in self.history.recent_contexts(user):
            kind, _, item = entry["context"].partition(":")
            if kind == "album":
                album = self.catalog.album(item)
                if album:
                    album.pop("tracks", None)
                    items.append({"kind": "album", "item": album, "played_at": entry["played_at"]})
            elif kind == "playlist":
                playlist = self.playlists.get(user, item)
                if playlist:
                    playlist.pop("tracks", None)
                    items.append({"kind": "playlist", "item": playlist, "played_at": entry["played_at"]})
            elif kind == "artist":
                name = self.db.value("SELECT name FROM track_artists WHERE artist_id = ? LIMIT 1", (item,))
                if name:
                    items.append({"kind": "artist", "item": {"id": item, "name": name}, "played_at": entry["played_at"]})
            elif kind in ("mix", "radio"):
                items.append({"kind": kind, "item": {"id": item}, "played_at": entry["played_at"]})
        return items[:8]

    def _albums(self, album_ids: list) -> list:
        return self.catalog.albums_by_id(album_ids)

    def _artists(self, artist_ids: list, signals: dict) -> list:
        return self.catalog.artists_by_id(artist_ids)


def _weighted_sample(rng, candidates: list, weight, count: int) -> list:
    """Efraimidis-Spirakis: a weighted shuffle that is stable for a given random seed."""
    keyed = []
    for candidate in sorted(candidates):
        value = max(float(weight(candidate) or 0), 1e-6)
        keyed.append((rng.random() ** (1.0 / value), candidate))
    keyed.sort(reverse=True)
    return [candidate for _, candidate in keyed[:count]]


def _spread(ids: list, tracks: dict) -> list:
    """Keeps the same artist from playing twice in a row where the pool allows."""
    result, pending = [], list(ids)
    while pending:
        last = tracks[result[-1]]["artist_id"] if result else None
        index = next((i for i, tid in enumerate(pending) if tracks[tid]["artist_id"] != last), 0)
        result.append(pending.pop(index))
    return result


def _mosaic(signals: dict, ids: list) -> list:
    albums = []
    for tid in ids:
        track = signals["tracks"].get(tid)
        if track and track["has_artwork"] and track["album_id"] not in albums:
            albums.append(track["album_id"])
        if len(albums) == 4:
            break
    return albums
