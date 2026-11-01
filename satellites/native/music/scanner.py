"""Indexes source folders in place. Files are only ever opened for reading.

A track keeps its identifier for as long as either its path or its content is known:
retagging a file (same path, new bytes) and moving it (new path, same bytes) both keep
the identity playlists, likes and history point at. A file that disappears is flagged
missing rather than forgotten, and comes back as the same track if it returns.
"""

from fnmatch import fnmatch
from pathlib import Path
import hashlib
import os

from . import audio, grouping
from .db import dumps, now

SAMPLE = 256 * 1024
COVER_NAMES = ("cover", "folder", "front", "album", "albumart", "artwork")
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")
LYRIC_SUFFIXES = (".lrc", ".txt")

ROW_COLUMNS = (
    "id", "path", "source", "folder", "filename", "format", "size", "mtime", "content_hash", "title",
    "artist", "artists", "artist_id", "album", "album_id", "album_artist", "album_artist_id", "track_no",
    "track_total", "disc_no", "disc_total", "year", "date", "genre", "genres", "composer", "producer", "label",
    "copyright", "isrc", "compilation", "comment", "mb_track_id", "mb_album_id", "mb_artist_id",
    "mb_release_group_id", "duration", "codec", "bitrate", "sample_rate", "bit_depth", "channels", "lossless",
    "rg_track_gain", "rg_track_peak", "rg_album_gain", "rg_album_peak", "has_artwork", "has_lyrics", "missing",
    "added_at", "indexed_at",
)


class ScanCancelled(Exception):
    pass


def fingerprint(path: Path, size: int) -> str:
    """Identity from the size and both ends of the file: cheap even for lossless albums."""
    digest = hashlib.sha256(str(size).encode("ascii"))
    with open(path, "rb") as file:
        digest.update(file.read(SAMPLE))
        if size > SAMPLE * 2:
            file.seek(-SAMPLE, os.SEEK_END)
            digest.update(file.read(SAMPLE))
    return digest.hexdigest()[:grouping.ID_LENGTH]


class Scanner:
    def __init__(self, db, storage_root: Path, options: dict = None):
        self.db = db
        self.storage_root = Path(storage_root).resolve()
        self.options = options or {}
        self._folder_art = {}

    # ---------- walking ----------

    def candidates(self, root: Path):
        excluded = [pattern for pattern in self.options.get("exclude") or [] if pattern]
        for directory, folders, files in os.walk(root, followlinks=False):
            current = Path(directory)
            folders[:] = sorted(name for name in folders
                                if not name.startswith(".") and not self._inside_storage(current / name))
            for name in sorted(files):
                path = current / name
                if path.suffix.lower() not in audio.FORMATS or name.startswith("._"):
                    continue
                relative = path.relative_to(root).as_posix()
                if any(fnmatch(relative, pattern) or fnmatch(name, pattern) for pattern in excluded):
                    continue
                if path.is_symlink() or not path.is_file():
                    continue
                yield path

    def _inside_storage(self, path: Path) -> bool:
        try:
            resolved = path.resolve()
        except OSError:
            return True
        return resolved == self.storage_root or self.storage_root in resolved.parents

    # ---------- scanning ----------

    def scan(self, roots: list, progress=None, cancelled=None) -> dict:
        counts = {"found": 0, "added": 0, "updated": 0, "moved": 0, "unchanged": 0, "duplicates": 0,
                  "restored": 0, "skipped": 0, "removed": 0}
        failed = []
        known = {row["path"]: row for row in self.db.all(
            "SELECT id, path, source, size, mtime, missing, content_hash FROM tracks")}
        seen = set()

        for root in roots:
            for path in self.candidates(root):
                if cancelled is not None and cancelled():
                    raise ScanCancelled()
                counts["found"] += 1
                seen.add(str(path))
                try:
                    self._one(root, path, known.get(str(path)), counts)
                except Exception as error:
                    failed.append({"file": path.name, "reason": str(error)[:200]})
                if progress is not None and counts["found"] % 25 == 0:
                    progress(dict(counts, failed=len(failed), current=path.name))

        counts["removed"] = self._flag_missing(seen)
        counts["failed"] = failed
        return counts

    def _one(self, root: Path, path: Path, known, counts: dict):
        status = os.stat(path)
        if known is not None and known["size"] == status.st_size and known["mtime"] == int(status.st_mtime):
            if known["source"] != str(root):
                folder = path.relative_to(root).parent.as_posix()
                self.db.execute("UPDATE tracks SET source = ?, folder = ? WHERE id = ?",
                                (str(root), "" if folder == "." else folder, known["id"]))
            if known["missing"]:
                self.db.execute("UPDATE tracks SET missing = 0 WHERE id = ?", (known["id"],))
                counts["restored"] += 1
            else:
                counts["unchanged"] += 1
            return

        info = audio.probe(path)
        minimum = float(self.options.get("min_duration") or 0)
        if minimum and info["duration"] is not None and info["duration"] < minimum:
            counts["skipped"] += 1
            return

        content = fingerprint(path, status.st_size)
        row = self._row(root, path, status, info, content)

        with self.db.transaction() as connection:
            if known is not None:
                row["id"] = known["id"]
                row.pop("added_at")
                self._update(connection, row)
                counts["updated"] += 1
                return

            twins = connection.execute("SELECT id, path FROM tracks WHERE content_hash = ?", (content,)).fetchall()
            live = [twin for twin in twins if twin["path"] != str(path) and Path(twin["path"]).is_file()]
            if live:
                connection.execute("INSERT INTO duplicates (path, track_id, found_at) VALUES (?, ?, ?) "
                                   "ON CONFLICT (path) DO UPDATE SET track_id = excluded.track_id",
                                   (str(path), live[0]["id"], now()))
                counts["duplicates"] += 1
                return
            if twins:
                row["id"] = twins[0]["id"]
                row.pop("added_at")
                self._update(connection, row)
                connection.execute("DELETE FROM duplicates WHERE path = ?", (str(path),))
                counts["moved"] += 1
                counts["updated"] += 1
                return

            taken = connection.execute("SELECT 1 FROM tracks WHERE id = ?", (content,)).fetchone()
            row["id"] = grouping.digest(content, path) if taken else content
            marks = ",".join("?" * len(ROW_COLUMNS))
            connection.execute(f"INSERT INTO tracks ({','.join(ROW_COLUMNS)}) VALUES ({marks})",
                               [row[column] for column in ROW_COLUMNS])
            self._index(connection, row)
            counts["added"] += 1

    def _update(self, connection, row: dict):
        columns = [column for column in ROW_COLUMNS if column in row and column != "id"]
        assignments = ", ".join(f"{column} = ?" for column in columns)
        connection.execute(f"UPDATE tracks SET {assignments} WHERE id = ?",
                           [row[column] for column in columns] + [row["id"]])
        self._index(connection, row)

    def _index(self, connection, row: dict):
        connection.execute("DELETE FROM track_artists WHERE track_id = ?", (row["id"],))
        names = _loads_list(row["artists"]) or [grouping.UNKNOWN_ARTIST]
        entries = [(name, "primary" if position == 0 else "featured", position) for position, name in enumerate(names)]
        entries.append((row["album_artist"], "album", 0))
        if row["composer"]:
            entries.append((row["composer"], "composer", 0))
        for name, role, position in entries:
            connection.execute("INSERT OR IGNORE INTO track_artists (track_id, artist_id, name, role, position) "
                               "VALUES (?, ?, ?, ?, ?)", (row["id"], grouping.artist_id(name), name, role, position))

        # keyed by the track's rowid: deleting by an UNINDEXED column would scan the whole index
        rowid = connection.execute("SELECT rowid FROM tracks WHERE id = ?", (row["id"],)).fetchone()[0]
        connection.execute("DELETE FROM track_search WHERE rowid = ?", (rowid,))
        connection.execute("INSERT INTO track_search (rowid, track_id, title, artists, album, album_artist, genre, "
                           "composer, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (rowid, row["id"], row["title"], " ".join(names), row["album"], row["album_artist"],
                            " ".join(_loads_list(row["genres"])), row["composer"] or "", row["folder"] or ""))

    def _flag_missing(self, seen: set) -> int:
        flagged = 0
        for row in self.db.all("SELECT id, path FROM tracks WHERE missing = 0"):
            if row["path"] in seen:
                continue
            if not Path(row["path"]).is_file():
                self.db.execute("UPDATE tracks SET missing = 1 WHERE id = ?", (row["id"],))
                flagged += 1
        return flagged

    # ---------- one file ----------

    def _row(self, root: Path, path: Path, status, info: dict, content: str) -> dict:
        relative = path.relative_to(root)
        tags = dict(info)
        if self.options.get("missing_metadata") == "folders":
            for key, value in grouping.infer_from_path(relative.parts).items():
                if not tags.get(key):
                    tags[key] = value
                    if key == "artist":
                        tags["artists"] = [value]

        title = tags.get("title") or path.stem
        artists = grouping.split_artists(tags.get("artists") or ([tags["artist"]] if tags.get("artist") else []),
                                         title)
        album, album_artist = grouping.album_identity({**tags, "artist": artists[0] if artists else None})
        genres = []
        for value in tags.get("genres") or []:
            for part in value.replace(";", "/").split("/"):
                if part.strip() and part.strip() not in genres:
                    genres.append(part.strip())

        folder = str(path.parent)
        if folder not in self._folder_art:
            if len(self._folder_art) > 512:
                self._folder_art.clear()
            self._folder_art[folder] = _sidecar(path.parent, COVER_NAMES, IMAGE_SUFFIXES) is not None
        sidecar_art = self._folder_art[folder]
        sidecar_lyrics = any(path.with_suffix(suffix).is_file() for suffix in LYRIC_SUFFIXES)
        stamp = now()

        return {
            "id": None,
            "path": str(path),
            "source": str(root),
            "folder": relative.parent.as_posix() if relative.parent.as_posix() != "." else "",
            "filename": path.name,
            "format": tags["format"],
            "size": status.st_size,
            "mtime": int(status.st_mtime),
            "content_hash": content,
            "title": title,
            "artist": tags.get("artist"),
            "artists": dumps(artists),
            "artist_id": grouping.artist_id(artists[0] if artists else grouping.UNKNOWN_ARTIST),
            "album": tags.get("album"),
            "album_id": grouping.album_id(album_artist, album),
            "album_artist": album_artist,
            "album_artist_id": grouping.artist_id(album_artist),
            "track_no": tags.get("track"),
            "track_total": tags.get("track_total"),
            "disc_no": tags.get("disc"),
            "disc_total": tags.get("disc_total"),
            "year": tags.get("year"),
            "date": tags.get("date"),
            "genre": genres[0] if genres else tags.get("genre"),
            "genres": dumps(genres),
            "composer": tags.get("composer"),
            "producer": tags.get("producer"),
            "label": tags.get("label"),
            "copyright": tags.get("copyright"),
            "isrc": tags.get("isrc"),
            "compilation": int(bool(tags.get("compilation"))),
            "comment": (tags.get("comment") or "")[:500] or None,
            "mb_track_id": tags.get("mb_track_id"),
            "mb_album_id": tags.get("mb_album_id"),
            "mb_artist_id": tags.get("mb_artist_id"),
            "mb_release_group_id": tags.get("mb_release_group_id"),
            "duration": tags.get("duration"),
            "codec": tags.get("codec") or tags["format"],
            "bitrate": tags.get("bitrate"),
            "sample_rate": tags.get("sample_rate"),
            "bit_depth": tags.get("bit_depth"),
            "channels": tags.get("channels"),
            "lossless": int(bool(tags.get("lossless"))),
            "rg_track_gain": tags.get("rg_track_gain"),
            "rg_track_peak": tags.get("rg_track_peak"),
            "rg_album_gain": tags.get("rg_album_gain"),
            "rg_album_peak": tags.get("rg_album_peak"),
            "has_artwork": int(bool(tags.get("has_artwork")) or sidecar_art),
            "has_lyrics": int(bool(tags.get("lyrics")) or sidecar_lyrics),
            "missing": 0,
            "added_at": stamp,
            "indexed_at": stamp,
        }


def _sidecar(folder: Path, names: tuple, suffixes: tuple):
    try:
        entries = {entry.name.lower(): entry for entry in folder.iterdir() if entry.is_file()}
    except OSError:
        return None
    for name in names:
        for suffix in suffixes:
            entry = entries.get(f"{name}{suffix}")
            if entry is not None:
                return entry
    return None


def sidecar_cover(folder: Path):
    return _sidecar(folder, COVER_NAMES, IMAGE_SUFFIXES)


def _loads_list(text) -> list:
    from .db import loads
    value = loads(text, [])
    return value if isinstance(value, list) else []
