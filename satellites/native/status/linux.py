"""Linux readings from /proc and /sys - standard library only.

Every reader takes the filesystem root it reads from, so the tests can point
it at a small fake tree. Each returns None (and records why in
`unsupported`) when the kernel or hardware doesn't expose that reading;
nothing here ever invents a value.
"""

from pathlib import Path
import os
import platform
import socket

# real, block-backed or network filesystems; everything else in /proc/mounts
# (proc, sysfs, cgroup, tmpfs, squashfs snaps, overlay layers...) is skipped
FILESYSTEMS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "vfat", "exfat",
               "ntfs", "ntfs3", "fuseblk", "hfsplus", "apfs", "nfs", "nfs4", "cifs", "smb3", "smbfs",
               "fuse.sshfs", "9p"}
NETWORK_FILESYSTEMS = {"nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "9p"}
CPU_SENSORS = ("coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "soc_thermal", "acpitz",
               "x86_pkg_temp", "thermal-fan-est")
SECTOR = 512  # /proc/diskstats always counts 512-byte sectors
MAX_INTERFACES = 32
MAX_SENSORS = 12


class LinuxBackend:
    platform = "Linux"

    def __init__(self, root: Path = Path("/")):
        self.root = Path(root)
        self.unsupported = {}
        self._system = None

    def _read(self, relative: str):
        try:
            return (self.root / relative.lstrip("/")).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def _missing(self, key: str, reason: str):
        self.unsupported[key] = reason
        return None

    # ---------- cpu ----------

    def cpu_times(self):
        text = self._read("proc/stat")
        if text is None:
            return self._missing("cpu.percent", "/proc/stat is not readable")
        total, cores = None, []
        for line in text.splitlines():
            if not line.startswith("cpu"):
                continue
            name, *values = line.split()
            numbers = [int(value) for value in values[:8]] + [0] * max(0, 8 - len(values))
            user, nice, system, idle, iowait, irq, softirq, steal = numbers[:8]
            everything = user + nice + system + idle + iowait + irq + softirq + steal
            entry = (everything - idle - iowait, everything)
            if name == "cpu":
                total = entry
            else:
                cores.append(entry)
        if total is None:
            return self._missing("cpu.percent", "/proc/stat has no cpu line")
        return {"total": total, "cores": cores}

    def load(self):
        try:
            return tuple(round(value, 2) for value in os.getloadavg())
        except (AttributeError, OSError):
            text = self._read("proc/loadavg")
            if text:
                try:
                    return tuple(round(float(value), 2) for value in text.split()[:3])
                except ValueError:
                    pass
        return self._missing("cpu.load", "the load average is not available")

    def frequency(self):
        currents, maxima = [], []
        cpus = self.root / "sys/devices/system/cpu"
        try:
            entries = sorted(cpus.glob("cpu[0-9]*"))
        except OSError:
            entries = []
        for cpu in entries:
            current = _number(self._read(f"sys/devices/system/cpu/{cpu.name}/cpufreq/scaling_cur_freq"))
            maximum = _number(self._read(f"sys/devices/system/cpu/{cpu.name}/cpufreq/cpuinfo_max_freq"))
            if current:
                currents.append(current / 1000)  # kHz -> MHz
            if maximum:
                maxima.append(maximum / 1000)
        if not currents:
            cpuinfo = self._read("proc/cpuinfo") or ""
            for line in cpuinfo.splitlines():
                key, _, value = line.partition(":")
                if key.strip() == "cpu MHz":
                    number = _number(value)
                    if number:
                        currents.append(number)
        if not currents:
            return self._missing("cpu.frequency", "the kernel exposes no CPU frequency (no cpufreq driver)")
        return {"current_mhz": round(sum(currents) / len(currents)), "max_mhz": round(max(maxima)) if maxima else None}

    def temperatures(self):
        sensors = []
        hwmon = self.root / "sys/class/hwmon"
        try:
            chips = sorted(hwmon.iterdir())
        except OSError:
            chips = []
        for chip in chips:
            name = (self._read(f"sys/class/hwmon/{chip.name}/name") or "").strip()
            try:
                inputs = sorted(chip.glob("temp*_input"))
            except OSError:
                continue
            for sensor in inputs:
                value = _number(self._read(f"sys/class/hwmon/{chip.name}/{sensor.name}"))
                if value is None:
                    continue
                prefix = sensor.name[:-len("_input")]
                label = (self._read(f"sys/class/hwmon/{chip.name}/{prefix}_label") or "").strip()
                celsius = value / 1000
                if -40 < celsius < 150:  # unplugged probes read as 0 or absurd values
                    sensors.append({"label": f"{name} {label}".strip() or chip.name, "celsius": round(celsius, 1),
                                    "cpu": name in CPU_SENSORS})
        if not sensors:
            thermal = self.root / "sys/class/thermal"
            try:
                zones = sorted(thermal.glob("thermal_zone*"))
            except OSError:
                zones = []
            for zone in zones:
                value = _number(self._read(f"sys/class/thermal/{zone.name}/temp"))
                kind = (self._read(f"sys/class/thermal/{zone.name}/type") or zone.name).strip()
                if value is not None and -40 < value / 1000 < 150:
                    sensors.append({"label": kind, "celsius": round(value / 1000, 1),
                                    "cpu": any(part in kind.lower() for part in ("cpu", "pkg", "soc", "acpitz"))})
        if not sensors:
            return self._missing("cpu.temperature", "no temperature sensors are exposed in /sys/class/hwmon "
                                                    "or /sys/class/thermal")
        return sensors[:MAX_SENSORS]

    # ---------- memory ----------

    def memory(self):
        text = self._read("proc/meminfo")
        if text is None:
            return self._missing("memory", "/proc/meminfo is not readable")
        values = {}
        for line in text.splitlines():
            key, _, rest = line.partition(":")
            number = _number(rest.split()[0] if rest.split() else "")
            if number is not None:
                values[key.strip()] = int(number) * 1024  # kB -> bytes
        total = values.get("MemTotal")
        if not total:
            return self._missing("memory", "/proc/meminfo has no MemTotal")
        available = values.get("MemAvailable")
        if available is None:  # kernels before 3.14
            available = values.get("MemFree", 0) + values.get("Buffers", 0) + values.get("Cached", 0)
        return {"total": total, "available": available,
                "swap_total": values.get("SwapTotal", 0), "swap_free": values.get("SwapFree", 0)}

    # ---------- storage ----------

    def partitions(self):
        text = self._read("proc/self/mounts") or self._read("proc/mounts")
        if text is None:
            return self._missing("storage", "/proc/mounts is not readable")
        found, devices = [], set()
        for line in text.splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            device, mount, filesystem = parts[0], _unescape(parts[1]), parts[2]
            if filesystem not in FILESYSTEMS:
                continue
            if device in devices:  # bind mounts and btrfs subvolumes repeat a device
                continue
            devices.add(device)
            kind = "network" if filesystem in NETWORK_FILESYSTEMS else "fixed"
            found.append({"mount": mount, "fs": filesystem, "kind": kind})
        return found

    def usage(self, mount: str):
        try:
            stats = os.statvfs(mount)
        except (OSError, AttributeError):
            return None
        total = stats.f_blocks * stats.f_frsize
        free = stats.f_bavail * stats.f_frsize
        used = (stats.f_blocks - stats.f_bfree) * stats.f_frsize
        return {"total": total, "used": used, "free": free}

    def disks(self):
        text = self._read("proc/diskstats")
        if text is None:
            return self._missing("storage.io", "/proc/diskstats is not readable")
        physical = set()
        block = self.root / "sys/block"
        try:
            for entry in block.iterdir():
                if (entry / "device").exists() and not entry.name.startswith(("loop", "ram", "zram", "sr")):
                    physical.add(entry.name)
        except OSError:
            pass
        disks = []
        for line in text.splitlines():
            parts = line.split()
            if len(parts) < 13 or parts[2] not in physical:
                continue
            disks.append({"name": parts[2], "read_bytes": int(parts[5]) * SECTOR,
                          "write_bytes": int(parts[9]) * SECTOR, "io_ms": int(parts[12])})
        if not disks:
            return self._missing("storage.io", "no physical disks were found in /proc/diskstats")
        return disks

    # ---------- network ----------

    def interfaces(self):
        text = self._read("proc/net/dev")
        if text is None:
            return self._missing("network", "/proc/net/dev is not readable")
        found = []
        for line in text.splitlines()[2:]:
            name, _, rest = line.partition(":")
            name = name.strip()
            values = rest.split()
            if not name or len(values) < 16:
                continue
            base = f"sys/class/net/{name}"
            if name == "lo":
                kind = "loopback"
            elif (self.root / base / "wireless").exists() or (self.root / base / "phy80211").exists():
                kind = "wifi"
            elif (self.root / base / "device").exists():
                kind = "ethernet"
            else:
                kind = "virtual"
            state = (self._read(f"{base}/operstate") or "unknown").strip()
            speed = _number(self._read(f"{base}/speed"))
            found.append({
                "name": name, "kind": kind,
                "up": state == "up" or (state == "unknown" and kind == "loopback"),
                "speed_mbps": int(speed) if speed and speed > 0 else None,
                "rx_bytes": int(values[0]), "rx_errors": int(values[2]), "rx_drops": int(values[3]),
                "tx_bytes": int(values[8]), "tx_errors": int(values[10]), "tx_drops": int(values[11]),
            })
        order = {"ethernet": 0, "wifi": 1, "virtual": 2, "loopback": 3}
        found.sort(key=lambda interface: (order[interface["kind"]], interface["name"]))
        return found[:MAX_INTERFACES]

    # ---------- system ----------

    def system(self):
        if self._system is None:
            release = {}
            for line in (self._read("etc/os-release") or self._read("usr/lib/os-release") or "").splitlines():
                key, _, value = line.partition("=")
                release[key.strip()] = value.strip().strip('"')
            cpuinfo = self._read("proc/cpuinfo") or ""
            model, cores = None, set()
            physical = core = None
            for line in cpuinfo.splitlines():
                key, _, value = (part.strip() for part in line.partition(":"))
                if key in ("model name", "Model", "Hardware", "cpu model") and not model:
                    model = value
                elif key == "physical id":
                    physical = value
                elif key == "core id":
                    core = value
                    cores.add((physical, core))
            board = (self._read("proc/device-tree/model") or "").strip("\x00\n ")
            self._system = {
                "os": release.get("PRETTY_NAME") or "Linux",
                "kernel": platform.release(),
                "architecture": platform.machine(),
                "hostname": socket.gethostname(),
                "cpu_model": model or board or None,
                "physical_cores": len(cores) or None,
                "vendor": (self._read("sys/class/dmi/id/sys_vendor") or "").strip() or None,
                "model": (self._read("sys/class/dmi/id/product_name") or "").strip() or board or None,
            }
        text = (self._read("proc/uptime") or "").split()
        uptime = _number(text[0]) if text else None
        return {**self._system, "uptime_seconds": round(uptime) if uptime is not None else None}

    def process_memory(self):
        text = self._read("proc/self/statm")
        try:
            return int(text.split()[1]) * os.sysconf("SC_PAGE_SIZE") if text else None
        except (ValueError, IndexError, OSError, AttributeError):
            return None

    def close(self):
        pass


def _number(text):
    if text is None:
        return None
    try:
        return float(str(text).strip())
    except ValueError:
        return None


def _unescape(path: str) -> str:
    """/proc/mounts escapes spaces and tabs in mount points as octal."""
    return path.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\")
