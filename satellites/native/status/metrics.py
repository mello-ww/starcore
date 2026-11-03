"""Turns a platform backend's raw counters into one snapshot of real readings.

The backend (linux.py or windows.py) reports what the operating system
exposes; this module computes everything that needs two readings (CPU
usage, throughput, StarCore's own CPU share), adds percentages, and leaves a
reading as None - never a guess - when it isn't available. Why a reading is
missing is reported under "unsupported".

Partition usage can block on a disconnected network share or a dead NFS
mount, so it is read on a worker thread with a time limit and cached: a
stuck mount makes the storage figures stale, never the whole sample.
"""

from threading import Event, Lock, Thread
import os
import platform
import sys
import time

STORAGE_SECONDS = 30  # partition usage changes slowly; read it at most this often
STORAGE_WAIT = 2.0    # how long a sample waits for a fresh partition reading
PHYSICAL_KINDS = ("ethernet", "wifi", "other")


def default_backend():
    if sys.platform == "win32":
        from .windows import WindowsBackend
        return WindowsBackend()
    if sys.platform.startswith("linux"):
        from .linux import LinuxBackend
        return LinuxBackend()
    return UnsupportedBackend()


class UnsupportedBackend:
    """macOS, BSD, ...: only what the standard library offers everywhere."""

    platform = platform.system() or "unknown"

    def __init__(self):
        reason = f"{self.platform} is not supported by the Status satellite yet"
        self.unsupported = {key: reason for key in ("cpu.percent", "cpu.frequency", "cpu.temperature", "memory",
                                                    "storage.io", "network")}

    def cpu_times(self):
        return None

    def load(self):
        try:
            return tuple(round(value, 2) for value in os.getloadavg())
        except (AttributeError, OSError):
            return None

    def frequency(self):
        return None

    def temperatures(self):
        return None

    def memory(self):
        return None

    def partitions(self):
        return []

    def usage(self, mount):
        return None

    def disks(self):
        return None

    def interfaces(self):
        return None

    def system(self):
        import socket
        return {"os": platform.platform(terse=True), "kernel": platform.release(), "architecture": platform.machine(),
                "hostname": socket.gethostname(), "cpu_model": platform.processor() or None, "physical_cores": None,
                "vendor": None, "model": None, "uptime_seconds": None}

    def process_memory(self):
        return None

    def close(self):
        pass


def percent(part, whole):
    if part is None or not whole:
        return None
    return round(min(max(part / whole * 100, 0.0), 100.0), 1)


class Collector:
    def __init__(self, backend=None, clock=time.monotonic):
        self.backend = backend or default_backend()
        self._clock = clock  # the tests step this to check rates exactly
        self._lock = Lock()
        self._previous = None
        self._storage = None           # last partition reading
        self._storage_at = 0.0
        self._storage_running = False
        self._storage_done = Event()

    def close(self):
        self.backend.close()

    # ---------- one reading ----------

    def sample(self) -> dict:
        """One snapshot. Rates need the previous call; the first one has none."""
        with self._lock:
            started = time.perf_counter()
            now, wall = self._clock(), time.time()
            tick = getattr(self.backend, "tick", None)
            if tick:
                tick()
            raw = {
                "cpu": self.backend.cpu_times(),
                "disks": self.backend.disks(),
                "interfaces": self.backend.interfaces(),
                "process": time.process_time(),
            }
            previous, self._previous = self._previous, (now, raw)
            elapsed = now - previous[0] if previous else None
            before = previous[1] if previous else {}

            snapshot = {
                "sampled_at": round(wall, 3),
                "cpu": self._cpu(raw["cpu"], before.get("cpu")),
                "memory": self._memory(),
                "storage": {**self._partitions(), "io": self._io(raw["disks"], before.get("disks"), elapsed)},
                "network": self._network(raw["interfaces"], before.get("interfaces"), elapsed),
                "system": self._system(wall),
                "process": self._process(raw["process"], before.get("process"), elapsed),
                "unsupported": dict(self.backend.unsupported),
            }
            snapshot["collect_ms"] = round((time.perf_counter() - started) * 1000, 2)
            return snapshot

    # ---------- sections ----------

    def _cpu(self, times, before):
        overall = per_core = None
        if times and before:
            overall = _busy(times["total"], before["total"])
            if len(times["cores"]) == len(before["cores"]):
                per_core = [_busy(now, then) for now, then in zip(times["cores"], before["cores"])]
        sensors = self.backend.temperatures()
        temperature = None
        if sensors:
            cpu_sensors = [sensor["celsius"] for sensor in sensors if sensor.get("cpu")]
            temperature = {"current": max(cpu_sensors or [sensor["celsius"] for sensor in sensors]),
                           "sensors": [{"label": sensor["label"], "celsius": sensor["celsius"]} for sensor in sensors]}
        load = self.backend.load()
        system = self.backend.system()
        return {
            "percent": overall,
            "per_core": per_core,
            "logical_cores": (len(times["cores"]) if times and times["cores"] else None) or os.cpu_count(),
            "physical_cores": system.get("physical_cores"),
            "model": system.get("cpu_model"),
            "load": {"1m": load[0], "5m": load[1], "15m": load[2]} if load else None,
            "frequency": self.backend.frequency(),
            "temperature": temperature,
        }

    def _memory(self):
        reading = self.backend.memory()
        if not reading:
            return None
        total, available = reading["total"], reading["available"]
        used = max(total - available, 0)
        swap_total = reading.get("swap_total") or 0
        swap_used = max(swap_total - (reading.get("swap_free") or 0), 0)
        return {
            "total": total, "available": available, "used": used, "percent": percent(used, total),
            "swap": {"total": swap_total, "used": swap_used, "free": max(swap_total - swap_used, 0),
                     "percent": percent(swap_used, swap_total)},
        }

    def _partitions(self):
        self.refresh_storage(STORAGE_WAIT if self._storage is None else 0)
        reading = self._storage or {"partitions": [], "at": None}
        stale = self._storage_running and time.monotonic() - self._storage_at > STORAGE_SECONDS * 3
        return {"partitions": reading["partitions"], "partitions_read_at": reading["at"], "stale": stale}

    def refresh_storage(self, wait: float = 0.0):
        """Reads partition usage on a worker thread when it's due; waits up to `wait` for it."""
        due = time.monotonic() - self._storage_at >= STORAGE_SECONDS or self._storage is None
        if due and not self._storage_running:
            self._storage_running = True
            self._storage_done.clear()
            Thread(target=self._read_storage, name="starcore-status-storage", daemon=True).start()
        if wait and self._storage_running:
            self._storage_done.wait(wait)

    def _read_storage(self):
        try:
            partitions = []
            for entry in self.backend.partitions() or []:
                usage = self.backend.usage(entry["mount"])
                if not usage or not usage["total"]:
                    continue
                used, free = usage["used"], usage["free"]
                partitions.append({**entry, "total": usage["total"], "used": used, "free": free,
                                   # like df: what is free to use, not counting reserved blocks
                                   "percent": percent(used, used + free)})
            self._storage = {"partitions": partitions, "at": round(time.time(), 3)}
        except Exception as error:  # a broken mount must never stop sampling
            self.backend.unsupported["storage"] = f"partitions could not be read ({type(error).__name__})"
        finally:
            self._storage_at = time.monotonic()
            self._storage_running = False
            self._storage_done.set()

    def _io(self, disks, before, elapsed):
        if disks is None:
            return None
        previous = {disk["name"]: disk for disk in before or []}
        found = []
        for disk in disks:
            if "read_bps" in disk:  # the backend already measured a rate (Windows)
                found.append(disk)
                continue
            then = previous.get(disk["name"])
            if not then or not elapsed:
                found.append({"name": disk["name"], "read_bps": None, "write_bps": None, "busy_percent": None})
                continue
            found.append({
                "name": disk["name"],
                "read_bps": _rate(disk["read_bytes"], then["read_bytes"], elapsed),
                "write_bps": _rate(disk["write_bytes"], then["write_bytes"], elapsed),
                "busy_percent": percent(max(disk["io_ms"] - then["io_ms"], 0), elapsed * 1000),
            })
        known = [disk for disk in found if disk["read_bps"] is not None]
        return {
            "read_bps": sum(disk["read_bps"] for disk in known) if known else None,
            "write_bps": sum(disk["write_bps"] or 0 for disk in known) if known else None,
            "disks": found,
        }

    def _network(self, interfaces, before, elapsed):
        if interfaces is None:
            return None
        previous = {interface["name"]: interface for interface in before or []}
        found = []
        for interface in interfaces:
            then = previous.get(interface["name"])
            found.append({
                **interface,
                "rx_bps": _rate(interface["rx_bytes"], then["rx_bytes"], elapsed) if then and elapsed else None,
                "tx_bps": _rate(interface["tx_bytes"], then["tx_bytes"], elapsed) if then and elapsed else None,
            })
        # bridges and virtual switches carry the same traffic a physical adapter
        # already counted, so totals use physical adapters when there are any
        counted = [interface for interface in found if interface["kind"] in PHYSICAL_KINDS] or \
                  [interface for interface in found if interface["kind"] != "loopback"]
        measured = [interface for interface in counted if interface["rx_bps"] is not None]
        return {
            "rx_bps": sum(interface["rx_bps"] for interface in measured) if measured else None,
            "tx_bps": sum(interface["tx_bps"] for interface in measured) if measured else None,
            "interfaces": found,
        }

    def _system(self, wall):
        system = dict(self.backend.system())
        uptime = system.get("uptime_seconds")
        system["boot_time"] = round(wall - uptime) if uptime is not None else None
        system["platform"] = self.backend.platform
        system["python"] = platform.python_version()
        return system

    def _process(self, cpu_time, before, elapsed):
        share = None
        if before is not None and elapsed:
            # StarCore's share of the whole machine, 0-100 like the CPU figure
            share = percent(cpu_time - before, elapsed * (os.cpu_count() or 1))
        return {"cpu_percent": share, "memory": self.backend.process_memory()}


def _busy(now, then):
    busy, everything = now[0] - then[0], now[1] - then[1]
    return percent(busy, everything) if everything > 0 else None


def _rate(now, then, elapsed):
    delta = now - then
    if delta < 0:  # the counter was reset (an adapter reconnected)
        return None
    return round(delta / elapsed)
