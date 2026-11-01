"""The Music database: one SQLite file beside the artwork cache, upgraded by numbered migrations.

The catalog (what is on disk) and listener data (playlists, likes, history, playback state)
share one file so a rescan can never orphan a playlist: tracks are only ever flagged missing,
and come back with the same identifier when their file does.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
import json
import os
import sqlite3

MIGRATIONS = (
    # 1: catalog, search index and listener data
    """
    CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        source TEXT,
        folder TEXT,
        filename TEXT,
        format TEXT,
        size INTEGER,
        mtime INTEGER,
        content_hash TEXT,
        title TEXT,
        artist TEXT,
        artists TEXT,
        artist_id TEXT,
        album TEXT,
        album_id TEXT,
        album_artist TEXT,
        album_artist_id TEXT,
        track_no INTEGER,
        track_total INTEGER,
        disc_no INTEGER,
        disc_total INTEGER,
        year INTEGER,
        date TEXT,
        genre TEXT,
        genres TEXT,
        composer TEXT,
        producer TEXT,
        label TEXT,
        copyright TEXT,
        isrc TEXT,
        compilation INTEGER DEFAULT 0,
        comment TEXT,
        mb_track_id TEXT,
        mb_album_id TEXT,
        mb_artist_id TEXT,
        mb_release_group_id TEXT,
        duration REAL,
        codec TEXT,
        bitrate INTEGER,
        sample_rate INTEGER,
        bit_depth INTEGER,
        channels INTEGER,
        lossless INTEGER DEFAULT 0,
        rg_track_gain REAL,
        rg_track_peak REAL,
        rg_album_gain REAL,
        rg_album_peak REAL,
        has_artwork INTEGER DEFAULT 0,
        has_lyrics INTEGER DEFAULT 0,
        missing INTEGER DEFAULT 0,
        hidden INTEGER DEFAULT 0,
        added_at TEXT,
        indexed_at TEXT
    );
    CREATE INDEX tracks_album ON tracks (album_id);
    CREATE INDEX tracks_artist ON tracks (artist_id);
    CREATE INDEX tracks_album_artist ON tracks (album_artist_id);
    CREATE INDEX tracks_content ON tracks (content_hash);
    CREATE INDEX tracks_added ON tracks (added_at);
    CREATE INDEX tracks_genre ON tracks (genre);
    CREATE INDEX tracks_folder ON tracks (source, folder);

    CREATE TABLE track_artists (
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        artist_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (track_id, artist_id, role)
    );
    CREATE INDEX track_artists_artist ON track_artists (artist_id, role);

    CREATE TABLE duplicates (
        path TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        found_at TEXT
    );

    CREATE VIRTUAL TABLE track_search USING fts5 (
        track_id UNINDEXED, title, artists, album, album_artist, genre, composer, folder,
        tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT,
        finished_at TEXT,
        source TEXT,
        result TEXT
    );

    CREATE TABLE favorites (
        user TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (user, kind, item_id)
    );

    CREATE TABLE pins (
        user TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (user, kind, item_id)
    );

    CREATE TABLE playlists (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        folder TEXT DEFAULT '',
        visibility TEXT DEFAULT 'private',
        cover TEXT,
        rules TEXT,
        created_at TEXT,
        updated_at TEXT
    );
    CREATE INDEX playlists_owner ON playlists (owner);

    CREATE TABLE playlist_tracks (
        entry_id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        added_at TEXT
    );
    CREATE INDEX playlist_tracks_order ON playlist_tracks (playlist_id, position);

    CREATE TABLE plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        track_id TEXT NOT NULL,
        played_at TEXT NOT NULL,
        seconds REAL DEFAULT 0,
        completed INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        device TEXT,
        context TEXT
    );
    CREATE INDEX plays_user_time ON plays (user, played_at);
    CREATE INDEX plays_user_track ON plays (user, track_id);

    CREATE TABLE preferences (
        user TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (user, key)
    );

    CREATE TABLE searches (
        user TEXT NOT NULL,
        query TEXT NOT NULL,
        searched_at TEXT,
        PRIMARY KEY (user, query)
    );

    CREATE TABLE playback_state (
        user TEXT NOT NULL,
        device_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (user, device_id)
    );

    CREATE TABLE devices (
        user TEXT NOT NULL,
        device_id TEXT NOT NULL,
        name TEXT,
        kind TEXT,
        session_id TEXT,
        capabilities TEXT,
        last_seen REAL,
        PRIMARY KEY (user, device_id)
    );

    CREATE TABLE lyrics_offsets (
        user TEXT NOT NULL,
        track_id TEXT NOT NULL,
        offset_ms INTEGER NOT NULL,
        PRIMARY KEY (user, track_id)
    );

    CREATE TABLE enrichment (
        key TEXT PRIMARY KEY,
        value TEXT,
        fetched_at TEXT
    );
    """,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"))


def loads(text, default=None):
    if text is None:
        return default
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return default


class Database:
    """One shared connection, serialized by a lock.

    SQLite answers the queries this satellite makes in microseconds; serializing them keeps
    every request consistent without a connection pool, and a scan releases the lock between
    files so browsing never waits on it for long.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = RLock()
        self.recovered_from = None
        self.connection = self._open()

    def _open(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            connection = self._connect()
        except sqlite3.DatabaseError as error:
            # never deleted: a damaged file is set aside for the administrator to inspect
            aside = self.path.with_name(f"{self.path.name}.damaged-{datetime.now():%Y%m%d%H%M%S}")
            print(f"[WARNING]: music database {self.path} is unreadable ({error}). "
                  f"It was moved to {aside.name} and a new one was started.")
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(f"{self.path}{suffix}")
                if candidate.exists():
                    os.replace(candidate, Path(f"{aside}{suffix}"))
            self.recovered_from = aside
            connection = self._connect()
        return connection

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise sqlite3.DatabaseError("integrity check failed")
            self._migrate(connection)
        except sqlite3.DatabaseError:
            connection.close()
            raise
        return connection

    def _migrate(self, connection):
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        for number, script in enumerate(MIGRATIONS, start=1):
            if number <= version:
                continue
            connection.execute("BEGIN")
            try:
                for statement in _statements(script):
                    connection.execute(statement)
                connection.execute(f"PRAGMA user_version = {number}")
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    @property
    def version(self) -> int:
        return self.one("PRAGMA user_version")[0]

    def all(self, sql: str, params=()) -> list:
        with self.lock:
            return self.connection.execute(sql, params).fetchall()

    def one(self, sql: str, params=()):
        with self.lock:
            return self.connection.execute(sql, params).fetchone()

    def value(self, sql: str, params=(), default=None):
        row = self.one(sql, params)
        return row[0] if row is not None and row[0] is not None else default

    def execute(self, sql: str, params=()) -> int:
        with self.lock:
            return self.connection.execute(sql, params).rowcount

    @contextmanager
    def transaction(self):
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise
            self.connection.execute("COMMIT")

    def close(self):
        with self.lock:
            try:
                self.connection.close()
            except sqlite3.Error:
                pass


def _statements(script: str):
    buffer = ""
    for line in script.splitlines():
        buffer += line + "\n"
        if line.rstrip().endswith(";") and sqlite3.complete_statement(buffer):
            yield buffer.strip()
            buffer = ""
    if buffer.strip():
        yield buffer.strip()
