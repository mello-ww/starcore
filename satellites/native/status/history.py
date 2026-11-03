"""Bounded, persistent metric history in one small SQLite file.

Every sample is folded into a 10-second bucket; each finished bucket is
written and folded into the next, coarser tier:

    tier   bucket   kept      serves
    10s    10 s     1 hour    the 1h view   (360 points)
    1m     1 min    24 hours  the 24h view  (1,440 points)
    10m    10 min   7 days    the 7d view   (1,008 points)
    1h     1 hour   30 days   the 30d view  (720 points)

so the file never holds more than about 3,500 rows per machine, whatever the
uptime. Each bucket keeps, per series, the average, the peak and how many
samples it covers, so coarser tiers stay true averages. The file is only
created once there is something to write: reading history never creates it.
Rows carry a node name ("local" today) so other machines can share the
format later.
"""

from pathlib import Path
from threading import Lock
import json
import math
import sqlite3
import time

TIERS = (("10s", 10, 3600), ("1m", 60, 86400), ("10m", 600, 7 * 86400), ("1h", 3600, 30 * 86400))
PERIODS = {"1h": ("10s", 3600), "24h": ("1m", 86400), "7d": ("10m", 7 * 86400), "30d": ("1h", 30 * 86400)}
SERIES = {
    "cpu": "%", "memory": "%", "swap": "%", "load": "", "temperature": "°C",
    "disk_read": "B/s", "disk_write": "B/s", "net_rx": "B/s", "net_tx": "B/s", "storage": "%",
}
SCHEMA = 1
TABLE = ("CREATE TABLE IF NOT EXISTS samples (node TEXT NOT NULL, tier TEXT NOT NULL, bucket INTEGER NOT NULL, "
         "data TEXT NOT NULL, PRIMARY KEY (node, tier, bucket)) WITHOUT ROWID")


def values_from(snapshot: dict) -> dict:
    """The series one snapshot contributes; a reading that isn't available is left out."""
    cpu = snapshot.get("cpu") or {}
    memory = snapshot.get("memory") or {}
    storage = snapshot.get("storage") or {}
    io = storage.get("io") or {}
    network = snapshot.get("network") or {}
    partitions = [partition["percent"] for partition in storage.get("partitions") or []
                  if partition.get("percent") is not None and partition.get("kind") in ("fixed", "removable")]
    values = {
        "cpu": cpu.get("percent"),
        "memory": memory.get("percent"),
        "swap": (memory.get("swap") or {}).get("percent"),
        "load": (cpu.get("load") or {}).get("1m"),
        "temperature": (cpu.get("temperature") or {}).get("current"),
        "disk_read": io.get("read_bps"),
        "disk_write": io.get("write_bps"),
        "net_rx": network.get("rx_bps"),
        "net_tx": network.get("tx_bps"),
        "storage": max(partitions) if partitions else None,
    }
    return {key: float(value) for key, value in values.items() if value is not None}


class Bucket:
    def __init__(self, start: int):
        self.start = start
        self.count = 0
        self.series = {}  # name -> [sum, samples, peak]

    def add(self, values: dict):
        self.count += 1
        for name, value in values.items():
            entry = self.series.setdefault(name, [0.0, 0, -math.inf])
            entry[0] += value
            entry[1] += 1
            entry[2] = max(entry[2], value)

    def merge(self, other: "Bucket"):
        self.count += other.count
        for name, (total, samples, peak) in other.series.items():
            entry = self.series.setdefault(name, [0.0, 0, -math.inf])
            entry[0] += total
            entry[1] += samples
            entry[2] = max(entry[2], peak)

    def encode(self) -> str:
        return json.dumps({"n": self.count, "s": {name: [round(total / samples, 3), round(peak, 3), samples]
                                                 for name, (total, samples, peak) in self.series.items() if samples}})

    @classmethod
    def decode(cls, start: int, text: str) -> "Bucket":
        bucket = cls(start)
        data = json.loads(text)
        bucket.count = int(data.get("n", 0))
        for name, (average, peak, samples) in (data.get("s") or {}).items():
            bucket.series[name] = [average * samples, samples, peak]
        return bucket


class HistoryStore:
    def __init__(self, path: Path, node: str = "local"):
        self.path = Path(path)
        self.node = node
        self._lock = Lock()
        self._connection = None
        self._open = {}  # tier name -> the bucket still being filled
        self.problem = None

    # ---------- the file ----------

    def _connect(self, create: bool):
        if self._connection is not None:
            return self._connection
        if not create and not self.path.is_file():
            return None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                connection = self._open_file()
            except sqlite3.DatabaseError as error:
                self._set_aside(error)
                connection = self._open_file()
        except (OSError, sqlite3.Error) as error:
            self.problem = f"history cannot be stored ({error})"
            return None
        self._connection = connection
        return connection

    def _open_file(self):
        connection = sqlite3.connect(self.path, check_same_thread=False, timeout=5)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(TABLE)
            connection.execute(f"PRAGMA user_version = {SCHEMA}")
            connection.execute("SELECT COUNT(*) FROM samples").fetchone()
            connection.commit()
        except sqlite3.DatabaseError:
            connection.close()
            raise
        return connection

    def _set_aside(self, error):
        """A damaged file is kept for inspection and history starts again."""
        broken = self.path.with_name(f"{self.path.name}.broken-{int(time.time())}")
        try:
            self.path.replace(broken)
            for suffix in ("-wal", "-shm"):
                self.path.with_name(self.path.name + suffix).unlink(missing_ok=True)
            self.problem = f"the history file was damaged ({error}) and was set aside as {broken.name}"
        except OSError:
            self.problem = f"the history file is damaged ({error})"

    def close(self):
        with self._lock:
            self._flush_open()
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    # ---------- writing ----------

    def record(self, at: float, values: dict):
        """Folds one sample in, writing every bucket it completes."""
        if values:
            with self._lock:
                size = TIERS[0][1]
                self._place(0, int(at // size * size), values=values)

    def flush(self):
        """Writes the buckets still being filled (on shutdown), so a restart loses nothing."""
        with self._lock:
            self._flush_open()

    def _place(self, level: int, start: int, values: dict = None, child: Bucket = None):
        name = TIERS[level][0]
        current = self._open.get(name)
        if current is not None and current.start != start:
            del self._open[name]
            self._complete(level, current)
            current = None
        if current is None:
            current = self._open[name] = Bucket(start)
        if child is not None:
            current.merge(child)
        else:
            current.add(values)

    def _complete(self, level: int, bucket: Bucket):
        self._store(level, bucket)
        if level + 1 < len(TIERS):
            size = TIERS[level + 1][1]
            self._place(level + 1, bucket.start // size * size, child=bucket)

    def _flush_open(self):
        for level in range(len(TIERS)):
            bucket = self._open.pop(TIERS[level][0], None)
            if bucket is None or not bucket.count:
                continue
            self._store(level, bucket)
            if level + 1 < len(TIERS):
                # the coarser tier gets the partial bucket too; after a restart
                # only new samples reach it, so nothing is counted twice
                size = TIERS[level + 1][1]
                parent_start = bucket.start // size * size
                parent = self._open.get(TIERS[level + 1][0])
                if parent is None or parent.start != parent_start:
                    if parent is not None:
                        self._store(level + 1, parent)
                    parent = self._open[TIERS[level + 1][0]] = Bucket(parent_start)
                parent.merge(bucket)

    def _store(self, level: int, bucket: Bucket):
        name, _, keep = TIERS[level]
        connection = self._connect(create=True)
        if connection is None:
            return
        try:
            existing = connection.execute("SELECT data FROM samples WHERE node = ? AND tier = ? AND bucket = ?",
                                          (self.node, name, bucket.start)).fetchone()
            stored = Bucket.decode(bucket.start, existing[0]) if existing else Bucket(bucket.start)
            stored.merge(bucket)  # a restart inside one bucket adds to it rather than replacing it
            connection.execute("INSERT OR REPLACE INTO samples (node, tier, bucket, data) VALUES (?, ?, ?, ?)",
                               (self.node, name, bucket.start, stored.encode()))
            connection.execute("DELETE FROM samples WHERE node = ? AND tier = ? AND bucket < ?",
                               (self.node, name, bucket.start - keep))
            connection.commit()
        except (sqlite3.Error, ValueError) as error:
            self.problem = f"history could not be written ({error})"

    # ---------- reading ----------

    def query(self, period: str = "24h", series=None, points: int = None, now: float = None) -> dict:
        if period not in PERIODS:
            raise ValueError(f"period must be one of {', '.join(PERIODS)}")
        tier, span = PERIODS[period]
        resolution = next(size for name, size, _ in TIERS if name == tier)
        now = time.time() if now is None else now
        since = int(now - span)
        wanted = [name for name in (series or SERIES) if name in SERIES]

        with self._lock:
            rows = []
            connection = self._connect(create=False)
            if connection is not None:
                try:
                    rows = connection.execute("SELECT bucket, data FROM samples WHERE node = ? AND tier = ? AND "
                                              "bucket >= ? ORDER BY bucket", (self.node, tier, since)).fetchall()
                except sqlite3.Error as error:
                    self.problem = f"history could not be read ({error})"
            buckets = []
            for start, data in rows:
                try:
                    buckets.append(Bucket.decode(start, data))
                except (ValueError, TypeError):
                    continue
            # the bucket still being filled, so the newest point is live
            live = self._open.get(tier)
            if live is not None and live.count and live.start >= since:
                pending = Bucket(live.start)
                pending.merge(live)
                if buckets and buckets[-1].start == pending.start:
                    buckets[-1].merge(pending)
                else:
                    buckets.append(pending)

        if points:
            # the whole period is divided into at most `points` fixed time slots,
            # aligned to the clock so a slot keeps its place from one refresh to
            # the next, however much of the period actually has samples
            slot = resolution * max(1, math.ceil(span / points / resolution))
            if slot > resolution:
                grouped = {}
                for bucket in buckets:
                    start = bucket.start // slot * slot
                    group = grouped.setdefault(start, Bucket(start))
                    group.merge(bucket)
                buckets = [grouped[start] for start in sorted(grouped)]
            resolution = slot

        result = {}
        for name in wanted:
            line = []
            for bucket in buckets:
                entry = bucket.series.get(name)
                if entry and entry[1]:
                    line.append([bucket.start, round(entry[0] / entry[1], 2), round(entry[2], 2)])
            result[name] = {"unit": SERIES[name], "points": line}
        return {"period": period, "resolution": resolution, "from": since, "to": int(now), "series": result}

    def stats(self) -> dict:
        with self._lock:
            counts = {}
            connection = self._connect(create=False)
            if connection is not None:
                try:
                    counts = dict(connection.execute("SELECT tier, COUNT(*) FROM samples WHERE node = ? GROUP BY tier",
                                                     (self.node,)).fetchall())
                except sqlite3.Error:
                    counts = {}
        size = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                size += self.path.with_name(self.path.name + suffix).stat().st_size
            except OSError:
                pass
        return {"rows": {name: counts.get(name, 0) for name, _, _ in TIERS}, "bytes": size, "problem": self.problem}
