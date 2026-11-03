"""The Status satellite: readings, collection, history, health, the API, the CLI and the page.

Linux readings are checked against a small fake /proc and /sys tree, so they
run on any machine; Windows readings run live only on Windows. Every store
lives in a temporary directory, and every timestamp fed to the history store
here is a test fixture, never shown anywhere.
"""

from http.client import HTTPConnection
from pathlib import Path
from threading import Event
from unittest import mock
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from starcore.api.response import Request
from starcore.auth import AuthStore
from starcore.cli import runner, spec
from starcore.cli.audit import AuditLog
from starcore.module_loader import register_package
from tests.support import start_engine, stop_engine
from tests.test_cli import isolate

REPO = Path(__file__).resolve().parents[2]
STATUS_DIR = REPO / "satellites" / "native" / "status"
register_package("satellites.native.status", STATUS_DIR)

from satellites.native.status import health, history, linux, metrics, monitor  # noqa: E402


# ---------- fixtures ----------

def write(root: Path, relative: str, text: str = ""):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def fake_linux(root: Path, step: int = 1):
    write(root, "proc/stat", f"cpu  {100 * step} 0 {50 * step} {800 * step} {50 * step} 0 0 0 0 0\n"
                             f"cpu0 {60 * step} 0 {20 * step} {400 * step} {20 * step} 0 0 0\n"
                             f"cpu1 {40 * step} 0 {30 * step} {400 * step} {30 * step} 0 0 0\nintr 1\n")
    write(root, "proc/meminfo", "MemTotal: 8000000 kB\nMemFree: 1000000 kB\nMemAvailable: 6000000 kB\n"
                                "SwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n")
    write(root, "proc/self/mounts", "/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\ntmpfs /run tmpfs rw 0 0\n"
                                    "/dev/sda1 /var/lib/bind ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n"
                                    "nas:/share /mnt/nas nfs4 rw 0 0\n/dev/loop0 /snap/core squashfs ro 0 0\n")
    write(root, "proc/diskstats", f"   8       0 sda {10 * step} 0 {200 * step} 5 {20 * step} 0 {100 * step} 9 0 {30 * step} 40\n"
                                  f"   8       1 sda1 1 0 2 3 4 0 5 6 0 7 8\n   7       0 loop0 1 0 2 3 4 0 5 6 0 7 8\n")
    (root / "sys/block/sda/device").mkdir(parents=True, exist_ok=True)
    (root / "sys/block/loop0").mkdir(parents=True, exist_ok=True)
    write(root, "proc/net/dev", "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n"
                                f"    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n"
                                f"  eth0: {10000 * step} 10 1 2 0 0 0 0 {4000 * step} 8 3 4 0 0 0 0\n"
                                f"docker0: {9000 * step} 9 0 0 0 0 0 0 {9000 * step} 9 0 0 0 0 0 0\n"
                                f" wlan0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
    for name, state in (("eth0", "up"), ("docker0", "up"), ("wlan0", "down"), ("lo", "unknown")):
        write(root, f"sys/class/net/{name}/operstate", state)
    write(root, "sys/class/net/eth0/speed", "1000")
    (root / "sys/class/net/eth0/device").mkdir(parents=True, exist_ok=True)
    (root / "sys/class/net/wlan0/wireless").mkdir(parents=True, exist_ok=True)
    write(root, "sys/class/hwmon/hwmon0/name", "coretemp")
    write(root, "sys/class/hwmon/hwmon0/temp1_input", "52000")
    write(root, "sys/class/hwmon/hwmon0/temp1_label", "Package id 0")
    write(root, "sys/class/hwmon/hwmon1/name", "nvme")
    write(root, "sys/class/hwmon/hwmon1/temp1_input", "41500")
    write(root, "sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "2400000")
    write(root, "sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", "4800000")
    write(root, "sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq", "1600000")
    write(root, "proc/uptime", "3600.5 7000.0\n")
    write(root, "proc/loadavg", "0.50 0.40 0.30 1/100 1234\n")
    write(root, "etc/os-release", 'NAME="Debian"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n')
    write(root, "proc/cpuinfo", "processor : 0\nmodel name : Example CPU 9000\nphysical id : 0\ncore id : 0\n\n"
                                "processor : 1\nmodel name : Example CPU 9000\nphysical id : 0\ncore id : 1\n")
    write(root, "sys/class/dmi/id/sys_vendor", "Example Corp\n")
    write(root, "sys/class/dmi/id/product_name", "Box 1\n")


class FakeBackend:
    """Scripted counters: every sample advances them by one step."""

    platform = "Fake"

    def __init__(self, gate: Event = None):
        self.unsupported = {"cpu.temperature": "no sensors in this fake"}
        self.step = 0
        self.gate = gate
        self.reset_network = False

    def cpu_times(self):
        self.step += 1
        step = self.step
        return {"total": (50 * step, 100 * step), "cores": [(25 * step, 100 * step), (75 * step, 100 * step)]}

    def load(self):
        return (0.5, 0.4, 0.3)

    def frequency(self):
        return {"current_mhz": 2400, "max_mhz": 4800}

    def temperatures(self):
        return None

    def memory(self):
        return {"total": 1000, "available": 250, "swap_total": 0, "swap_free": 0}

    def partitions(self):
        return [{"mount": "/", "fs": "ext4", "kind": "fixed"}, {"mount": "/mnt/nas", "fs": "nfs", "kind": "network"}]

    def usage(self, mount):
        if self.gate is not None:
            self.gate.wait()
        return {"total": 100, "used": 60, "free": 30}

    def disks(self):
        step = self.step
        return [{"name": "sda", "read_bytes": 1000 * step, "write_bytes": 500 * step, "io_ms": 100 * step}]

    def interfaces(self):
        step = 0 if self.reset_network else self.step
        return [
            {"name": "eth0", "kind": "ethernet", "up": True, "speed_mbps": 1000, "rx_bytes": 1000 * step,
             "tx_bytes": 100 * step, "rx_errors": 0, "tx_errors": 0, "rx_drops": 0, "tx_drops": 0},
            {"name": "docker0", "kind": "virtual", "up": True, "speed_mbps": None, "rx_bytes": 5000 * step,
             "tx_bytes": 5000 * step, "rx_errors": 0, "tx_errors": 0, "rx_drops": 0, "tx_drops": 0},
        ]

    def system(self):
        return {"os": "FakeOS 1", "kernel": "1.0", "architecture": "x86_64", "hostname": "fakehost",
                "cpu_model": "Fake CPU", "physical_cores": 1, "vendor": None, "model": None, "uptime_seconds": 100}

    def process_memory(self):
        return 4096

    def close(self):
        pass


class SteppedClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        self.now += 1.0
        return self.now


def sample_twice(collector):
    collector.sample()
    return collector.sample()


# ---------- platform readings ----------

class LinuxBackendTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="starcore-status-linux-"))
        fake_linux(self.root)
        self.backend = linux.LinuxBackend(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_cpu_counters_exclude_idle_and_iowait(self):
        times = self.backend.cpu_times()
        self.assertEqual(times["total"], (150, 1000))
        self.assertEqual(times["cores"], [(80, 500), (70, 500)])

    def test_memory_uses_available_and_reads_swap(self):
        memory = self.backend.memory()
        self.assertEqual(memory["total"], 8000000 * 1024)
        self.assertEqual(memory["available"], 6000000 * 1024)
        self.assertEqual((memory["swap_total"], memory["swap_free"]), (2000000 * 1024, 1500000 * 1024))

    def test_partitions_keep_real_filesystems_once(self):
        found = self.backend.partitions()
        self.assertEqual([(item["mount"], item["kind"]) for item in found],
                         [("/", "fixed"), ("/mnt/my disk", "fixed"), ("/mnt/nas", "network")])

    def test_only_physical_disks_are_counted(self):
        disks = self.backend.disks()
        self.assertEqual([disk["name"] for disk in disks], ["sda"])
        self.assertEqual(disks[0]["read_bytes"], 200 * 512)
        self.assertEqual(disks[0]["io_ms"], 30)

    def test_interfaces_are_classified_and_sorted(self):
        found = {item["name"]: item for item in self.backend.interfaces()}
        self.assertEqual(found["eth0"]["kind"], "ethernet")
        self.assertEqual(found["eth0"]["speed_mbps"], 1000)
        self.assertEqual((found["eth0"]["rx_errors"], found["eth0"]["tx_drops"]), (1, 4))
        self.assertEqual(found["wlan0"]["kind"], "wifi")
        self.assertFalse(found["wlan0"]["up"])
        self.assertEqual(found["docker0"]["kind"], "virtual")
        self.assertEqual(found["lo"]["kind"], "loopback")
        self.assertEqual([item["name"] for item in self.backend.interfaces()], ["eth0", "wlan0", "docker0", "lo"])

    def test_temperatures_frequency_and_system(self):
        sensors = self.backend.temperatures()
        self.assertIn({"label": "coretemp Package id 0", "celsius": 52.0, "cpu": True}, sensors)
        self.assertEqual(self.backend.frequency(), {"current_mhz": 2000, "max_mhz": 4800})
        system = self.backend.system()
        self.assertEqual(system["os"], "Debian GNU/Linux 12 (bookworm)")
        self.assertEqual(system["cpu_model"], "Example CPU 9000")
        self.assertEqual(system["physical_cores"], 2)
        self.assertEqual((system["vendor"], system["model"]), ("Example Corp", "Box 1"))
        self.assertEqual(system["uptime_seconds"], 3600)

    def test_load_average(self):
        load = self.backend.load()
        self.assertEqual(len(load), 3)
        if not hasattr(os, "getloadavg"):
            self.assertEqual(load, (0.5, 0.4, 0.3))

    def test_missing_readings_are_reported_not_invented(self):
        empty = linux.LinuxBackend(self.root / "nothing")
        self.assertIsNone(empty.cpu_times())
        self.assertIsNone(empty.memory())
        self.assertIsNone(empty.temperatures())
        self.assertIsNone(empty.frequency())
        self.assertIsNone(empty.interfaces())
        for key in ("cpu.percent", "memory", "cpu.temperature", "cpu.frequency", "network"):
            self.assertIn(key, empty.unsupported)


@unittest.skipUnless(sys.platform == "win32", "reads the live Windows APIs")
class WindowsBackendTest(unittest.TestCase):
    def test_live_readings_are_plausible(self):
        from satellites.native.status import windows
        from ctypes import sizeof

        self.assertEqual(sizeof(windows.MIB_IF_ROW2), 1352)
        backend = windows.WindowsBackend()
        try:
            backend.tick()
            first = backend.cpu_times()
            time.sleep(0.3)
            backend.tick()
            second = backend.cpu_times()
            self.assertGreater(second["total"][1], first["total"][1])
            self.assertEqual(len(second["cores"]), os.cpu_count())
            memory = backend.memory()
            self.assertGreater(memory["available"], 0)
            self.assertGreater(memory["total"], memory["available"])
            self.assertTrue(backend.partitions())
            self.assertIsInstance(backend.interfaces(), list)
            self.assertIn("cpu.temperature", backend.unsupported)
            self.assertTrue(backend.system()["os"].startswith("Windows"))
        finally:
            backend.close()


# ---------- collecting ----------

class CollectorTest(unittest.TestCase):
    def test_first_sample_has_no_rates_and_the_second_does(self):
        collector = metrics.Collector(FakeBackend(), clock=SteppedClock())
        first = collector.sample()
        self.assertIsNone(first["cpu"]["percent"])
        self.assertIsNone(first["network"]["rx_bps"])

        second = collector.sample()
        self.assertEqual(second["cpu"]["percent"], 50.0)
        self.assertEqual(second["cpu"]["per_core"], [25.0, 75.0])
        self.assertEqual(second["storage"]["io"]["read_bps"], 1000)
        self.assertEqual(second["storage"]["io"]["disks"][0]["busy_percent"], 10.0)
        # totals count the physical adapter only; the bridge repeats its traffic
        self.assertEqual(second["network"]["rx_bps"], 1000)
        self.assertEqual(second["network"]["tx_bps"], 100)

    def test_percentages_and_missing_swap(self):
        snapshot = sample_twice(metrics.Collector(FakeBackend(), clock=SteppedClock()))
        self.assertEqual(snapshot["memory"]["used"], 750)
        self.assertEqual(snapshot["memory"]["percent"], 75.0)
        self.assertIsNone(snapshot["memory"]["swap"]["percent"])
        partition = snapshot["storage"]["partitions"][0]
        self.assertEqual(partition["percent"], 66.7)  # used / (used + free), as df reports it
        self.assertEqual(snapshot["unsupported"], {"cpu.temperature": "no sensors in this fake"})
        self.assertIsNone(snapshot["cpu"]["temperature"])
        self.assertEqual(snapshot["cpu"]["load"], {"1m": 0.5, "5m": 0.4, "15m": 0.3})

    def test_a_counter_reset_gives_no_rate(self):
        backend = FakeBackend()
        collector = metrics.Collector(backend, clock=SteppedClock())
        sample_twice(collector)
        backend.reset_network = True
        self.assertIsNone(collector.sample()["network"]["interfaces"][0]["rx_bps"])

    def test_a_stuck_drive_never_blocks_a_sample(self):
        gate = Event()
        collector = metrics.Collector(FakeBackend(gate), clock=SteppedClock())
        try:
            with mock.patch.object(metrics, "STORAGE_WAIT", 0.1):
                started = time.monotonic()
                snapshot = collector.sample()
                self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(snapshot["storage"]["partitions"], [])
        finally:
            gate.set()
        collector.refresh_storage(wait=2)
        self.assertEqual(len(collector.sample()["storage"]["partitions"]), 2)

    def test_the_default_backend_matches_this_platform(self):
        backend = metrics.default_backend()
        try:
            expected = "Windows" if sys.platform == "win32" else "Linux" if sys.platform.startswith("linux") else None
            if expected:
                self.assertEqual(backend.platform, expected)
            snapshot = sample_twice(metrics.Collector(backend))
            self.assertIn("cpu", snapshot)
            self.assertGreaterEqual(snapshot["collect_ms"], 0)
        finally:
            backend.close()


# ---------- history ----------

class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-status-history-"))
        self.path = self.directory / "history.db"
        self.store = history.HistoryStore(self.path)

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.directory, ignore_errors=True)

    def feed(self, store, start, seconds, every=5, cpu=lambda second: 50.0):
        for offset in range(0, seconds, every):
            store.record(start + offset, {"cpu": cpu(offset), "memory": 40.0})

    def test_reading_never_creates_the_file(self):
        result = self.store.query("24h")
        self.assertEqual(result["series"]["cpu"]["points"], [])
        self.assertFalse(self.path.exists())

    def test_samples_fold_into_buckets_with_average_and_peak(self):
        start = 1_800_000_000  # a fixed instant, divisible by 3600
        self.feed(self.store, start, 120, cpu=lambda second: 20.0 if second % 10 else 80.0)
        result = self.store.query("1h", ["cpu"], now=start + 125)
        points = result["series"]["cpu"]["points"]
        self.assertEqual(result["resolution"], 10)
        self.assertEqual(points[0], [start, 50.0, 80.0])
        self.assertEqual(len(points), 12)

        minute = self.store.query("24h", ["cpu", "memory"], now=start + 125)
        self.assertEqual(minute["series"]["cpu"]["points"][0][:2], [start, 50.0])
        self.assertEqual(minute["series"]["memory"]["points"][0][1], 40.0)

    def test_every_tier_stays_bounded(self):
        start = 1_800_000_000
        self.feed(self.store, start, 3 * 3600, every=10)
        rows = self.store.stats()["rows"]
        self.assertLessEqual(rows["10s"], 361)
        self.assertLessEqual(rows["1m"], 24 * 60 + 1)
        self.assertGreater(rows["1h"], 0)

    def test_points_merge_buckets_into_true_averages(self):
        start = 1_800_000_000
        self.feed(self.store, start, 3600, every=10, cpu=lambda second: float(second % 100))
        full = self.store.query("1h", ["cpu"], now=start + 3600)
        merged = self.store.query("1h", ["cpu"], points=60, now=start + 3600)
        self.assertLessEqual(len(merged["series"]["cpu"]["points"]), 60)
        self.assertGreater(merged["resolution"], full["resolution"])
        all_points = full["series"]["cpu"]["points"]
        overall = sum(point[1] for point in all_points) / len(all_points)
        merged_points = merged["series"]["cpu"]["points"]
        self.assertAlmostEqual(sum(point[1] for point in merged_points) / len(merged_points), overall, delta=1.0)
        self.assertEqual(max(point[2] for point in merged_points), max(point[2] for point in all_points))

    def test_points_divide_the_whole_period_into_fixed_slots(self):
        start = 1_800_000_000
        self.feed(self.store, start, 4 * 3600, every=10)
        # only 4 of the 24 hours have samples: slots still follow the period, not the data
        result = self.store.query("24h", ["cpu"], points=60, now=start + 4 * 3600)
        self.assertEqual(result["resolution"], 1440)
        points = result["series"]["cpu"]["points"]
        self.assertTrue(all(point[0] % 1440 == 0 for point in points))
        self.assertLessEqual(len(points), 4 * 3600 // 1440 + 2)

    def test_a_restart_inside_a_bucket_adds_to_it_without_counting_twice(self):
        start = 1_800_000_000
        self.store.record(start + 1, {"cpu": 10.0})
        self.store.close()  # flushes the partial buckets

        again = history.HistoryStore(self.path)
        again.record(start + 3, {"cpu": 30.0})
        again.record(start + 70, {"cpu": 90.0})  # closes the first 10 s and 1 min buckets
        again.record(start + 130, {"cpu": 90.0})
        tens = again.query("1h", ["cpu"], now=start + 140)["series"]["cpu"]["points"]
        self.assertEqual(tens[0][:3], [start, 20.0, 30.0])
        minutes = again.query("24h", ["cpu"], now=start + 140)["series"]["cpu"]["points"]
        self.assertEqual(minutes[0][:2], [start, 20.0])
        again.close()

    def test_a_damaged_file_is_set_aside(self):
        self.path.write_bytes(b"this is not a database" * 100)
        store = history.HistoryStore(self.path)
        store.record(1_800_000_000, {"cpu": 1.0})
        store.record(1_800_000_020, {"cpu": 1.0})
        self.assertIn("set aside", store.problem)
        self.assertTrue(list(self.directory.glob("history.db.broken-*")))
        store.close()

    def test_periods_and_snapshot_values(self):
        with self.assertRaises(ValueError):
            self.store.query("2h")
        values = history.values_from({
            "cpu": {"percent": 12.5, "load": None, "temperature": None},
            "memory": {"percent": 40.0, "swap": {"percent": None}},
            "storage": {"partitions": [{"kind": "fixed", "percent": 70.0}, {"kind": "network", "percent": 99.0},
                                       {"kind": "fixed", "percent": 85.0}], "io": None},
            "network": None,
        })
        self.assertEqual(values, {"cpu": 12.5, "memory": 40.0, "storage": 85.0})


# ---------- health ----------

class HealthTest(unittest.TestCase):
    def services(self, running=True, satellites=(), mission_control=True):
        return {"engine": {"running": running, "mission_control": {"enabled": True, "running": mission_control}},
                "satellites": list(satellites)}

    def test_thresholds(self):
        snapshot = {"memory": {"swap": {"percent": 85.0}}, "cpu": {"temperature": {"current": 96.0}},
                    "storage": {"partitions": [{"mount": "/", "kind": "fixed", "percent": 98.0, "free": 10},
                                               {"mount": "/data", "kind": "fixed", "percent": 50.0, "free": 10}]}}
        result = health.evaluate(snapshot, {"cpu": 93.0, "memory": 99.0}, self.services())
        levels = {warning["id"]: warning["level"] for warning in result["warnings"]}
        self.assertEqual(levels, {"cpu": "warning", "memory": "critical", "swap": "warning",
                                  "temperature": "critical", "storage:/": "critical"})
        self.assertEqual(result["state"], "critical")
        self.assertEqual(result["warnings"][0]["level"], "critical")

    def test_quiet_readings_are_healthy_and_missing_ones_raise_nothing(self):
        result = health.evaluate({"cpu": {"temperature": None}, "memory": None}, {"cpu": None, "memory": 50.0},
                                 self.services())
        self.assertEqual(result, {"state": "ok", "warnings": []})

    def test_services(self):
        satellites = [{"name": "Music", "status": "error", "enabled": True, "last_error": "start hook failed"},
                      {"name": "Photo", "status": "stopped", "enabled": True, "last_error": None},
                      {"name": "Old", "status": "disabled", "enabled": False, "last_error": None}]
        result = health.evaluate({}, {}, self.services(satellites=satellites, mission_control=False),
                                 {"stalled": True})
        ids = [warning["id"] for warning in result["warnings"]]
        self.assertEqual(ids[0], "satellite:Music")
        self.assertIn("satellite:Photo", ids)
        self.assertIn("mission-control", ids)
        self.assertIn("sampler", ids)
        self.assertNotIn("satellite:Old", ids)

    def test_a_stopped_engine_is_one_warning(self):
        satellites = [{"name": "Music", "status": "stopped", "enabled": True, "last_error": None}]
        result = health.evaluate({}, {}, self.services(running=False, satellites=satellites, mission_control=False))
        self.assertEqual([warning["id"] for warning in result["warnings"]], ["engine"])


# ---------- the monitor, the API and the CLI ----------

class StatusEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        cls.satellite = cls.engine.registry.get("Status")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-status-"))
        # the satellite listing asks every satellite for its state: none may touch a real library
        isolate(self.engine, self.directory / "others")
        self.satellite.config.data["storage"] = str(self.directory / "status")
        self.satellite.config.data.pop("sample_interval", None)
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.engine.audit = AuditLog(self.directory / "audit.log")
        self.monitor = monitor.monitor_for(self.engine, self.satellite)
        self.monitor.collector = metrics.Collector(FakeBackend(), clock=SteppedClock())

    def tearDown(self):
        monitor.forget(self.satellite)
        shutil.rmtree(self.directory, ignore_errors=True)

    # ---------- monitor ----------

    def test_on_demand_snapshots_write_nothing(self):
        snapshot = self.monitor.snapshot()
        self.assertFalse(snapshot["sampling"])
        self.assertIs(self.monitor.snapshot(), snapshot)  # reused for a second
        self.assertFalse((self.directory / "status" / "history.db").exists())
        self.assertIn("services", snapshot)
        self.assertIn(snapshot["health"]["state"], ("ok", "warning", "critical"))

    def test_settle_takes_a_second_reading_for_rates(self):
        self.assertEqual(self.monitor.snapshot(settle=0.01)["cpu"]["percent"], 50.0)

    def test_the_sampler_records_history_and_stops_cleanly(self):
        with mock.patch.object(monitor.Monitor, "interval", new_callable=mock.PropertyMock, return_value=0.05):
            self.monitor.start()
            deadline = time.monotonic() + 10
            while self.monitor.stats["samples"] < 3 and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(self.monitor.running)
            self.assertTrue(self.monitor.snapshot()["sampling"])
            self.monitor.stop()
        self.assertFalse(self.monitor.running)
        self.assertGreaterEqual(self.monitor.stats["samples"], 3)
        self.assertGreater(self.monitor.history.stats()["rows"]["10s"], 0)
        self.assertTrue(self.monitor.history.query("1h", ["cpu"])["series"]["cpu"]["points"])

    def test_the_interval_is_clamped(self):
        for value, expected in ((1, 2), (999, 60), ("soon", 5), (10, 10)):
            self.satellite.config.data["sample_interval"] = value
            self.assertEqual(self.monitor.interval, expected)

    def test_a_stalled_sampler_is_reported(self):
        self.monitor.snapshot()
        with mock.patch.object(monitor.Monitor, "running", new_callable=mock.PropertyMock, return_value=True):
            self.monitor._latest_at -= 600
            self.assertTrue(self.monitor._sampler_state()["stalled"])
            warnings = [warning["id"] for warning in self.monitor.snapshot()["health"]["warnings"]]
            self.assertIn("sampler", warnings)

    def test_the_summary_is_flat_and_drawn_from_the_snapshot(self):
        summary = self.satellite.state(self.engine)
        self.assertEqual(set(summary), {"health", "cpu_percent", "memory_percent", "satellites_online",
                                        "satellites_total", "warnings", "warning_count", "platform", "python"})
        self.assertTrue(all(isinstance(value, (str, int, float, list, type(None))) for value in summary.values()))
        self.assertEqual(summary["satellites_total"], len(self.engine.registry.all()))

    # ---------- API ----------

    def request(self, path, method="GET", token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, json.loads(body) if body else None
        finally:
            connection.close()

    def test_every_route_needs_a_session(self):
        token = self.engine.auth.bootstrap("admin", "a very good password")
        for route in ("metrics", "history", "diagnostics", "mobile"):
            with self.subTest(route=route):
                self.assertEqual(self.request(f"/api/satellites/status/{route}")[0], 401)
                self.assertEqual(self.request(f"/api/satellites/status/{route}", token=token)[0], 200)

    def test_metrics_history_and_diagnostics(self):
        status, metrics_payload = self.request("/api/satellites/status/metrics")
        self.assertEqual(status, 200)
        for key in ("node", "interval", "sampling", "health", "cpu", "memory", "storage", "network", "system",
                    "services", "unsupported"):
            self.assertIn(key, metrics_payload)
        self.assertEqual(metrics_payload["node"]["id"], "local")

        status, payload = self.request("/api/satellites/status/history?period=7d&series=cpu,net_rx&points=50")
        self.assertEqual(status, 200)
        self.assertEqual((payload["period"], set(payload["series"])), ("7d", {"cpu", "net_rx"}))

        status, payload = self.request("/api/satellites/status/diagnostics")
        self.assertEqual(status, 200)
        self.assertEqual([tier["tier"] for tier in payload["history"]["tiers"]], ["10s", "1m", "10m", "1h"])
        self.assertNotIn("token", json.dumps(payload).lower())
        self.assertNotIn(str(self.directory), json.dumps(payload))

    def test_history_validation(self):
        for query in ("period=2h", "series=cpu,bogus", "points=5", "points=many"):
            with self.subTest(query=query):
                self.assertEqual(self.request(f"/api/satellites/status/history?{query}")[0], 400)
        self.assertEqual(self.request("/api/satellites/status/metrics", method="POST")[0], 405)

    def test_the_listing_carries_the_home_summary(self):
        status, payload = self.request("/api/satellites")
        entry = next(item for item in payload["satellites"] if item["name"] == "Status")
        self.assertIn("health", entry["state"])
        self.assertIn("cpu_percent", entry["state"])
        self.assertEqual(entry["page"], {"module": "page.js", "stylesheet": "page.css"})

    def test_the_mobile_screen_shows_real_readings(self):
        response = self.satellite.routes["mobile"](Request(self.engine, self.satellite, "GET", (), {}))
        labels = [item["label"] for item in response.payload["screen"]["sections"][0]["items"]]
        self.assertEqual(labels[:4], ["Health", "CPU", "Memory", "Satellites"])

    def test_page_assets_are_served(self):
        for name, kind in (("page.js", "javascript"), ("charts.js", "javascript"), ("format.js", "javascript"),
                           ("page.css", "text/css")):
            connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
            try:
                connection.request("GET", f"/api/satellites/status/assets/{name}")
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 200)
                self.assertIn(kind, response.headers.get("Content-Type", ""))
            finally:
                connection.close()

    # ---------- CLI ----------

    def run_json(self, line, context=None):
        outcome = self.engine.run_command(f"{line} --json", context or runner.terminal_context(self.engine))
        return outcome.exit_code, json.loads(outcome.stdout)

    def test_cli_commands(self):
        code, payload = self.run_json("status")
        self.assertEqual(code, 0)
        self.assertIn(payload["data"]["health"]["state"], ("ok", "warning", "critical"))
        self.assertEqual(self.run_json("status hardware")[1]["data"]["cpu"]["model"], "Fake CPU")
        self.assertEqual(self.run_json("status network")[1]["data"]["interfaces"][0]["name"], "eth0")
        self.assertIn("components", self.run_json("status services")[1]["data"])
        code, payload = self.run_json("status history --period 1h --series cpu")
        self.assertEqual((code, payload["data"]["period"], list(payload["data"]["series"])), (0, "1h", ["cpu"]))

    def test_cli_validation_and_remote_use(self):
        self.assertEqual(self.engine.run_command("status history --period 2h",
                                                 runner.terminal_context(self.engine)).exit_code, spec.EXIT_USAGE)
        self.assertEqual(self.engine.run_command("status history --series cpu,bogus",
                                                 runner.terminal_context(self.engine)).exit_code, spec.EXIT_USAGE)
        # read-only, so a signed-in console may run them
        self.assertEqual(self.engine.run_command("status hardware", runner.remote_context(self.engine)).exit_code, 0)

    def test_cli_history_renders_recorded_samples(self):
        now = time.time()
        for offset in range(0, 300, 10):
            self.monitor.history.record(now - 300 + offset, {"cpu": float(offset % 50), "net_rx": 1000.0})
        output = self.engine.run_command("status history --period 1h", runner.terminal_context(self.engine)).stdout
        self.assertIn("Last 1h", output)
        self.assertIn("cpu", output)
        self.assertIn("net_rx", output)
        output.encode("ascii")  # any console can print it


# ---------- the Mission Control page and the Home summary ----------

class StatusPageTest(unittest.TestCase):
    def test_home_reads_the_summary_from_the_listing_it_already_polls(self):
        app = (REPO / "mission_control" / "app.js").read_text(encoding="utf-8")
        page = (REPO / "mission_control" / "index.html").read_text(encoding="utf-8")
        self.assertIn("renderHomeHealth();", app)
        self.assertNotIn("/api/satellites/status/metrics", app)  # no second poll from Home
        for element in ("home-health", "home-health-cpu", "home-health-memory", "home-health-satellites",
                        "home-health-warnings"):
            self.assertIn(f'id="{element}"', page)

    def test_tokens_stay_in_sync(self):
        css = (REPO / "mission_control" / "tokens.css").read_text(encoding="utf-8")
        self.assertIn("--sc-chart-2: #7d808a;", css)

    @unittest.skipUnless(shutil.which("node"), "needs Node.js")
    def test_page_helpers(self):
        folder = (STATUS_DIR / "mission_control").as_uri()
        script = f"""
import * as f from "{folder}/format.js";
const assert = (ok, message) => {{ if (!ok) {{ console.error(message); process.exit(1); }} }};
assert(f.bytes(1536) === "1.5 KiB", "bytes " + f.bytes(1536));
assert(f.bytes(null) === f.DASH, "bytes dash");
assert(f.byteRate(1048576) === "1.0 MiB/s", "byteRate " + f.byteRate(1048576));
assert(f.bitRate(125000) === "1.0 Mb/s", "bitRate " + f.bitRate(125000));
assert(f.linkSpeed(2500) === "2.5 Gb/s" && f.linkSpeed(100) === "100 Mb/s", "linkSpeed");
assert(f.percent(7.44) === "7.4%" && f.percent(42.4) === "42%" && f.percent(90.44) === "90.4%", "percent");
assert(f.megahertz(4493) === "4.49 GHz", "MHz " + f.megahertz(4493));
assert(f.duration(90061) === "1d 1h" && f.duration(59) === "59s", "duration");
assert(f.span(86400) === "24 hours" && f.span(604800) === "7 days" && f.span(10) === "10 s", "span");
globalThis.document = undefined;
const charts = await import("{folder}/charts.js");
assert(charts.niceMaximum(73, "percent") === 100, "percent max");
assert(charts.niceMaximum(3_000_000, "bytes") === 5 * 1024 * 1024, "bytes max " + charts.niceMaximum(3_000_000, "bytes"));
assert(charts.niceMaximum(60_000, "bits") === 500_000 / 8, "bits max " + charts.niceMaximum(60_000, "bits"));
const runs = charts.segments([[0, 1], [10, 1], [20, 1], [100, 1], [110, 1]], 10);
assert(runs.length === 2 && runs[0].length === 3 && runs[1].length === 2, "gaps split lines");
console.log("ok");
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True,
                                timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
