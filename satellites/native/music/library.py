"""The music library: an index over files that stay where the listener put them.

Photos are copied into StarCore because a phone throws them at it; a music
collection is already organised on disk and can be large, so this satellite
indexes in place and never moves, rewrites or deletes a file.
"""

from pathlib import Path
from threading import Lock, Thread
import json
import os

from . import audio, grouping
from .catalog import Catalog
from .collection import Collection
from .connect import Connect
from .db import Database, dumps, loads, now
from .discovery import Discovery
from .history import History
from .playlists import Playlists
from .scanner import ScanCancelled, Scanner, sidecar_cover
from .search import Search
from .transcode import Transcoder
from .users import Preferences

SATELLITE_NAME = "Music"
INDEX_VERSION = 2
ARTWORK_SIZES = (96, 300, 600)

UNKNOWN_ALBUM = grouping.UNKNOWN_ALBUM
UNKNOWN_ARTIST = grouping.UNKNOWN_ARTIST

_libraries = {}
_libraries_lock = Lock()


class MusicScanError(Exception):
    """Raised when a caller asks for a directory the library cannot scan."""


def library(satellite):
    root = storage_root(satellite)
    with _libraries_lock:
        if root not in _libraries:
            _libraries[root] = MusicLibrary(root, satellite.config.get("library", "~/Music"))
        music = _libraries[root]
    music.configure(satellite.config)
    return music


def library_for(engine):
    satellite = engine.registry.get(SATELLITE_NAME)
    return library(satellite) if satellite else None


def storage_root(satellite) -> Path:
    configured = Path(str(satellite.config.get("storage", "data"))).expanduser()
    root = configured if configured.is_absolute() else satellite.path / configured
    return root.resolve()


class MusicLibrary:
    def __init__(self, root: Path, source: str = "~/Music", sources=(), options: dict = None):
        self.root = Path(root).resolve()
        self.artwork_dir = self.root / "artwork"
        self.covers_dir = self.root / "covers"
        self.cache_dir = self.root / "cache"
        self.index_path = self.root / "music.db"
        self.legacy_index = self.root / "library.json"
        self.source = str(source)
        self.sources = list(sources)
        self.options = dict(options or {})
        self.db = Database(self.index_path)
        self.catalog = Catalog(self.db)
        self.collection = Collection(self.db, self.catalog)
        self.playlists = Playlists(self.db, self.catalog)
        self.history = History(self.db, self.catalog)
        self.preferences = Preferences(self.db)
        self.finder = Search(self.db, self.catalog, self.playlists)
        self.discovery = Discovery(self.db, self.catalog, self.history, self.collection, self.playlists)
        self.connect = Connect(self.db)
        self.transcoder = Transcoder(self.cache_dir / "transcodes")
        self._scan_lock = Lock()
        self._scan_state = {"running": False, "progress": None, "last": None, "error": None}
        self._cancel = False
        self._import_legacy()
        self._check_search_index()

    def configure(self, config):
        self.source = str(config.get("library", self.source) or "")
        extra = config.get("sources", [])
        self.sources = [str(item) for item in extra if str(item).strip()] if isinstance(extra, list) else []
        self.options = {
            "exclude": config.get("exclude", []) if isinstance(config.get("exclude", []), list) else [],
            "min_duration": config.get("min_duration", 0),
            "missing_metadata": config.get("missing_metadata", "filename"),
        }
        self.transcoder.binary = str(config.get("ffmpeg", "ffmpeg") or "ffmpeg")
        self.transcoder.cache_bytes = max(int(config.get("transcode_cache_mb", 2048) or 64), 64) * 1024 * 1024

    def close(self):
        self.db.close()

    # ---------- library ----------

    @property
    def count(self) -> int:
        return self.catalog.count()

    @property
    def size(self) -> int:
        return self.catalog.totals()["size_bytes"]

    @property
    def duration(self) -> float:
        return self.catalog.totals()["duration"]

    def summary(self) -> dict:
        totals = self.catalog.totals()
        return {
            "tracks": totals["tracks"],
            "albums": self.catalog.album_count(),
            "artists": self.catalog.artist_count(),
            "size_bytes": totals["size_bytes"],
            "duration": totals["duration"],
            "lossless": totals["lossless"],
            "hires": totals["hires"],
            "missing": totals["missing"],
            "hidden": totals["hidden"],
            "by_format": totals["by_format"],
            "last_scan": self.last_scan,
            "source": str(self._expand(self.source)) if self.source else "",
            "sources": [str(path) for path in self.source_paths()],
            "storage": str(self.root),
            "formats": sorted(set(audio.FORMATS.values())),
            "schema": self.db.version,
        }

    @property
    def last_scan(self):
        return self.db.value("SELECT value FROM meta WHERE key = 'last_scan'")

    def tracks(self) -> list:
        return self.catalog.tracks(include_path=True)["tracks"]

    def track(self, track_id):
        return self.catalog.track(track_id, include_path=True)

    def albums(self) -> list:
        return self.catalog.albums()

    def album(self, album_id):
        return self.catalog.album(album_id)

    def artists(self) -> list:
        return self.catalog.artists()

    def track_path(self, track: dict) -> Path:
        path = Path(track["path"]) if "path" in track else None
        if path is None:
            row = self.catalog.track_row(track["id"])
            path = Path(row["path"]) if row else None
        if path is None or not path.is_file():
            raise MusicScanError("the file is no longer on disk")
        return path

    def set_hidden(self, track_ids: list, hidden: bool) -> int:
        changed = 0
        for track_id in track_ids:
            changed += self.db.execute("UPDATE tracks SET hidden = ? WHERE id = ?", (int(bool(hidden)), track_id))
        return changed

    # ---------- artwork ----------

    def artwork_path(self, album: dict, size: int = None):
        """Cover art for an album: embedded art first, then a cover image beside the files."""
        original = self._artwork_original(album)
        if original is None or not size:
            return original
        return self._resized(original, album["id"], size) or original

    def _artwork_original(self, album: dict):
        if not album.get("artwork"):
            return None

        cached = next((path for path in self.artwork_dir.glob(f"{album['id']}.*") if path.suffix != ".part"), None)
        if cached is not None:
            return cached

        row = self.catalog.track_row(album["artwork"])
        if row is None:
            return None

        extracted = audio.artwork(Path(row["path"]))
        if extracted is None:
            sidecar = sidecar_cover(Path(row["path"]).parent)
            return sidecar

        data, content_type = extracted
        if not (data[:4] == b"\x89PNG" or data[:2] == b"\xff\xd8"):
            return None
        return self._write_cached(self.artwork_dir, album["id"], "png" if content_type.endswith("png") else "jpg", data)

    def _write_cached(self, directory: Path, name: str, extension: str, data: bytes) -> Path:
        # written aside and moved into place, so a request arriving while another is
        # still writing never reads half a file
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{name}.{extension}"
        partial = directory / f".{name}.{os.getpid()}.part"
        partial.write_bytes(data)
        os.replace(partial, target)
        return target

    def _resized(self, original: Path, name: str, size: int):
        size = min(ARTWORK_SIZES, key=lambda candidate: abs(candidate - int(size)))
        target = self.artwork_dir / "sized" / f"{name}-{size}.jpg"
        if target.is_file() and target.stat().st_mtime >= original.stat().st_mtime:
            return target
        try:
            from PIL import Image
        except ImportError:
            return None
        try:
            with Image.open(original) as image:
                image.thumbnail((size, size))
                target.parent.mkdir(parents=True, exist_ok=True)
                partial = target.with_name(f".{target.name}.{os.getpid()}.part")
                image.convert("RGB").save(partial, "JPEG", quality=85)
                os.replace(partial, target)
            return target
        except Exception:
            return None

    # ---------- scanning ----------

    def source_paths(self) -> list:
        paths = []
        for candidate in [self.source, *self.sources]:
            if not str(candidate).strip():
                continue
            path = self._expand(str(candidate).strip())
            if path not in paths:
                paths.append(path)
        return paths

    def scan(self, source=None) -> dict:
        """Indexes one directory, or every configured source. Safe to run repeatedly."""
        roots = [self._source(source)] if source else self._configured_roots()
        if not self._scan_lock.acquire(blocking=False):
            raise MusicScanError("a scan is already running")
        try:
            self._scan_state.update(running=True, progress=None, error=None)
            self._cancel = False
            return self._run_scan(roots)
        finally:
            self._scan_state["running"] = False
            self._scan_lock.release()

    def scan_in_background(self, source=None) -> dict:
        roots = [self._source(source)] if source else self._configured_roots()
        if not self._scan_lock.acquire(blocking=False):
            raise MusicScanError("a scan is already running")
        self._scan_state.update(running=True, progress=None, error=None)
        self._cancel = False

        def run():
            try:
                self._run_scan(roots)
            except ScanCancelled:
                self._scan_state["error"] = "cancelled"
            except Exception as error:
                self._scan_state["error"] = str(error)
            finally:
                self._scan_state["running"] = False
                self._scan_lock.release()

        Thread(target=run, name="starcore-music-scan", daemon=True).start()
        return self.scan_status()

    def cancel_scan(self):
        self._cancel = True

    def scan_status(self) -> dict:
        last = self._scan_state["last"]
        if last is None:
            stored = self.db.value("SELECT result FROM scans ORDER BY id DESC LIMIT 1")
            last = loads(stored)
        return {"running": self._scan_state["running"], "progress": self._scan_state["progress"],
                "error": self._scan_state["error"], "last": last, "last_scan": self.last_scan}

    def _run_scan(self, roots: list) -> dict:
        started = now()
        scanner = Scanner(self.db, self.root, self.options)

        def progress(state):
            self._scan_state["progress"] = state

        counts = scanner.scan(roots, progress=progress, cancelled=lambda: self._cancel)
        result = {"source": str(roots[0]) if len(roots) == 1 else [str(root) for root in roots], **counts,
                  "tracks": self.count}
        finished = now()
        self.db.execute("INSERT INTO meta (key, value) VALUES ('last_scan', ?) "
                        "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (finished,))
        self.db.execute("INSERT INTO scans (started_at, finished_at, source, result) VALUES (?, ?, ?, ?)",
                        (started, finished, dumps(result["source"]), dumps(result)))
        self.db.execute("DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT 50)")
        self._scan_state["last"] = result
        return result

    def _configured_roots(self) -> list:
        configured = [candidate for candidate in [self.source, *self.sources] if str(candidate).strip()]
        if not configured:
            raise MusicScanError("no music directory is configured")
        roots = []
        for candidate in configured:
            path = self._source(candidate)
            if path not in roots:
                roots.append(path)
        return roots

    def _source(self, source) -> Path:
        candidate = str(source or "").strip()
        if not candidate:
            raise MusicScanError("no music directory is configured")

        path = self._expand(candidate)
        if not path.exists():
            raise MusicScanError(f"'{path}' does not exist")
        if not path.is_dir():
            raise MusicScanError(f"'{path}' is not a directory")

        return path

    def _expand(self, source: str) -> Path:
        try:
            return Path(source).expanduser().resolve()
        except OSError:
            return Path(source)

    def _check_search_index(self):
        """The search index is keyed by track rowid, which a VACUUM may renumber: rebuild if they drifted."""
        indexed = self.db.value("SELECT COUNT(*) FROM track_search", default=0)
        aligned = self.db.value("SELECT COUNT(*) FROM track_search s JOIN tracks t ON t.rowid = s.rowid "
                                "AND t.id = s.track_id", default=0)
        total = self.db.value("SELECT COUNT(*) FROM tracks", default=0)
        if indexed == aligned == total:
            return
        scanner = Scanner(self.db, self.root, self.options)
        with self.db.transaction() as connection:
            connection.execute("DELETE FROM track_search")
            for row in connection.execute("SELECT * FROM tracks").fetchall():
                scanner._index(connection, dict(row))

    # ---------- the JSON index this database replaced ----------

    def _import_legacy(self):
        """Brings tracks from library.json across once, keeping their identifiers. The file stays."""
        if self.db.value("SELECT value FROM meta WHERE key = 'legacy_import'") or not self.legacy_index.is_file():
            return
        try:
            index = json.loads(self.legacy_index.read_text(encoding="utf-8"))
            tracks = index.get("tracks") if isinstance(index, dict) else None
        except (OSError, json.JSONDecodeError) as error:
            print(f"[WARNING]: music index {self.legacy_index} could not be read ({error}). It was not imported.")
            tracks = None

        imported = 0
        if isinstance(tracks, dict):
            scanner = Scanner(self.db, self.root, self.options)
            for track_id, track in tracks.items():
                try:
                    imported += self._import_one(scanner, track_id, track)
                except Exception as error:
                    print(f"[WARNING]: legacy music entry {track_id} was not imported ({error}).")
            if index.get("last_scan"):
                self.db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('last_scan', ?)",
                                (index["last_scan"],))
        self.db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_import', ?)",
                        (dumps({"at": now(), "tracks": imported}),))

    def _import_one(self, scanner: Scanner, track_id: str, track: dict) -> int:
        path = Path(str(track.get("path", "")))
        if not path.name or self.db.one("SELECT 1 FROM tracks WHERE id = ? OR path = ?", (track_id, str(path))):
            return 0
        tags = {key: track.get(key) for key in ("title", "artist", "album", "album_artist", "track", "disc", "year",
                                                "genre", "duration", "has_artwork")}
        tags.update({"format": track.get("format") or "mp3", "artists": [track["artist"]] if track.get("artist") else [],
                     "genres": [track["genre"]] if track.get("genre") else []})
        status = type("Status", (), {"st_size": track.get("size") or 0, "st_mtime": track.get("mtime") or 0})()
        row = scanner._row(path.parent, path, status, tags, track_id)
        row["id"] = track_id
        row["missing"] = int(not path.is_file())
        row["added_at"] = track.get("indexed_at") or now()
        row["has_artwork"] = int(bool(track.get("has_artwork")))
        row["has_lyrics"] = 0
        from .scanner import ROW_COLUMNS
        with self.db.transaction() as connection:
            marks = ",".join("?" * len(ROW_COLUMNS))
            connection.execute(f"INSERT INTO tracks ({','.join(ROW_COLUMNS)}) VALUES ({marks})",
                               [row[column] for column in ROW_COLUMNS])
            scanner._index(connection, row)
        return 1


def readable_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def readable_duration(seconds) -> str:
    total = int(seconds or 0)
    if total >= 3600:
        return f"{total // 3600}h {total % 3600 // 60}m"
    return f"{total // 60}:{total % 60:02d}"
