"""The Status monitor: one sampler, one cached snapshot, one history.

While the Status satellite's service runs, a background thread takes a
sample every `sample_interval` seconds (default 5), keeps the latest
snapshot in memory and folds it into the history file. Everything else -
the API, the Home summary, the CLI - reads that snapshot instead of
measuring again, so opening more views never costs more sampling.

When the service isn't running (satellite services turned off, the
one-shot CLI with no StarCore running, the tests) a snapshot is taken on
demand instead, at most once a second, and nothing is written.
"""

from collections import deque
from pathlib import Path
from threading import Event, Lock, Thread
import time

from starcore import runtime_paths

from . import health, history, services
from .metrics import Collector

DEFAULT_INTERVAL = 5
MIN_INTERVAL, MAX_INTERVAL = 2, 60
AVERAGE_SECONDS = 60
ON_DEMAND_SECONDS = 1.0

_monitors = {}
_monitors_lock = Lock()


def storage_root(satellite) -> Path:
    """Where history.db lives: StarCore's data directory unless `storage` names another place."""
    configured = str(satellite.config.get("storage", "data") or "data").strip()
    if configured == "data":
        return (runtime_paths.data_dir() / "satellites" / satellite.manifest.name).resolve()
    path = Path(configured).expanduser()
    return (path if path.is_absolute() else satellite.path / path).resolve()


def monitor_for(engine, satellite) -> "Monitor":
    root = storage_root(satellite)
    with _monitors_lock:
        monitor = _monitors.get(root)
        if monitor is None:
            monitor = _monitors[root] = Monitor(engine, satellite, root)
    # a reloaded satellite is a new object; the monitor keeps its history
    monitor.engine, monitor.satellite = engine, satellite
    return monitor


def forget(satellite):
    """Drops a stopped monitor (tests use this to start from nothing)."""
    with _monitors_lock:
        monitor = _monitors.pop(storage_root(satellite), None)
    if monitor is not None:
        monitor.stop()
        monitor.history.close()
        monitor.collector.close()


class Monitor:
    def __init__(self, engine, satellite, root: Path, collector: Collector = None):
        self.engine = engine
        self.satellite = satellite
        self.root = root
        self.collector = collector or Collector()
        self.history = history.HistoryStore(root / "history.db")
        self._lock = Lock()
        self._latest = None
        self._latest_at = 0.0  # monotonic
        self._recent = deque()  # (monotonic, cpu, memory) over the last minute
        self._averages = {}
        self._thread = None
        self._stopping = Event()
        self.stats = {"samples": 0, "errors": 0, "last_error": None, "last_ms": None, "average_ms": None,
                      "started_at": None}

    @property
    def interval(self) -> int:
        try:
            value = int(self.satellite.config.get("sample_interval", DEFAULT_INTERVAL))
        except (TypeError, ValueError):
            value = DEFAULT_INTERVAL
        return max(MIN_INTERVAL, min(value, MAX_INTERVAL))

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ---------- lifecycle ----------

    def start(self):
        if self.running:
            return
        self._stopping.clear()
        self.stats["started_at"] = round(time.time(), 3)
        self._thread = Thread(target=self._run, name="starcore-status-sampler", daemon=True)
        self._thread.start()

    def stop(self):
        thread, self._thread = self._thread, None
        if thread is not None:
            self._stopping.set()
            thread.join(timeout=10)
        self.history.flush()

    def _run(self):
        while not self._stopping.is_set():
            started = time.monotonic()
            try:
                self._sample(record=True)
            except Exception as error:  # one failed reading must not end sampling
                self.stats["errors"] += 1
                self.stats["last_error"] = f"{type(error).__name__}: {error}"
                print(f"[WARNING]: Status sampling failed: {self.stats['last_error']}")
            self._stopping.wait(max(0.5, self.interval - (time.monotonic() - started)))

    # ---------- sampling ----------

    def _sample(self, record: bool) -> dict:
        reading = self.collector.sample()
        now = time.monotonic()
        cpu = (reading.get("cpu") or {}).get("percent")
        memory = (reading.get("memory") or {}).get("percent")
        service_state = services.describe(self.engine)
        with self._lock:
            self._recent.append((now, cpu, memory))
            while self._recent and now - self._recent[0][0] > AVERAGE_SECONDS:
                self._recent.popleft()
            averages = self._averages = {
                "cpu": _average(entry[1] for entry in self._recent),
                "memory": _average(entry[2] for entry in self._recent),
            }
        snapshot = {
            "node": {"id": "local", "name": (reading.get("system") or {}).get("hostname"), "kind": "local"},
            "interval": self.interval,
            "sampling": self.running,
            **reading,
            "services": service_state,
        }
        snapshot["health"] = health.evaluate(snapshot, averages, service_state, self._sampler_state())
        if record:
            self.history.record(reading["sampled_at"], history.values_from(reading))
            elapsed = reading.get("collect_ms")
            self.stats["samples"] += 1
            self.stats["last_ms"] = elapsed
            if elapsed is not None:
                previous = self.stats["average_ms"]
                self.stats["average_ms"] = round(elapsed if previous is None else previous * 0.9 + elapsed * 0.1, 2)
        with self._lock:
            self._latest, self._latest_at = snapshot, now
        return snapshot

    def _sampler_state(self) -> dict:
        stalled = self.running and self._latest_at and time.monotonic() - self._latest_at > max(3 * self.interval, 30)
        return {"running": self.running, "stalled": bool(stalled)}

    # ---------- reading ----------

    def snapshot(self, settle: float = 0.0) -> dict:
        """The latest snapshot. Without the sampler, one is taken now; `settle`
        waits that long for a second reading when there is no earlier one, so
        rates like CPU usage aren't empty (the one-shot CLI uses this)."""
        with self._lock:
            latest, age = self._latest, time.monotonic() - self._latest_at
        if self.running and latest is not None:
            sampler = self._sampler_state()
            if sampler["stalled"]:
                # the thread stopped answering: say so instead of serving an old verdict
                return {**latest, "health": health.evaluate(latest, self._averages, latest.get("services"), sampler)}
            return latest
        if latest is not None and age < ON_DEMAND_SECONDS:
            return latest
        snapshot = self._sample(record=False)
        if settle and latest is None:
            time.sleep(settle)
            snapshot = self._sample(record=False)
        return snapshot

    def summary(self) -> dict:
        """What Home shows: small, flat, and taken from the same snapshot as everything else."""
        snapshot = self.snapshot()
        state = snapshot["health"]
        service_state = snapshot.get("services") or {}
        return {
            "health": state["state"],
            "cpu_percent": (snapshot.get("cpu") or {}).get("percent"),
            "memory_percent": (snapshot.get("memory") or {}).get("percent"),
            "satellites_online": service_state.get("online"),
            "satellites_total": service_state.get("total"),
            "warnings": [warning["title"] for warning in state["warnings"][:3]],
            "warning_count": len(state["warnings"]),
            "platform": (snapshot.get("system") or {}).get("platform"),
            "python": (snapshot.get("system") or {}).get("python"),
        }

    def history_query(self, period: str, series=None, points=None) -> dict:
        result = self.history.query(period, series, points)
        return {**result, "sampling": self.running, "interval": self.interval}

    def diagnostics(self) -> dict:
        snapshot = self.snapshot()
        return {
            "node": snapshot.get("node"),
            "platform": (snapshot.get("system") or {}).get("platform"),
            "python": (snapshot.get("system") or {}).get("python"),
            "sampler": {**self.stats, **self._sampler_state(), "interval": self.interval},
            "collect_ms": snapshot.get("collect_ms"),
            "process": snapshot.get("process"),
            "history": {**self.history.stats(),
                        "tiers": [{"tier": name, "bucket_seconds": size, "kept_seconds": keep}
                                  for name, size, keep in history.TIERS]},
            "unsupported": snapshot.get("unsupported") or {},
            "storage_stale": (snapshot.get("storage") or {}).get("stale", False),
        }


def _average(values):
    known = [value for value in values if value is not None]
    return round(sum(known) / len(known), 1) if known else None
