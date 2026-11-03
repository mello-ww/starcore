"""Windows readings through the Win32 API (ctypes) - standard library only.

What is read from where:
- CPU usage: GetSystemTimes (overall) and NtQuerySystemInformation (per core)
- CPU frequency, disk throughput and disk busy time: Performance Data Helper
  (PDH) counters, the same ones Task Manager shows
- Memory: GlobalMemoryStatusEx; page file: NtQuerySystemInformation
- Partitions: logical drives, their type and file system
- Network: GetIfTable2 (64-bit counters, link speed, state, friendly name)

Windows offers no load average, and no CPU temperature without vendor tools
or administrator WMI access, so those two are reported as unsupported.
"""

from ctypes import (POINTER, Structure, WinDLL, byref, c_double, c_int, c_long, c_longlong, c_size_t, c_ubyte,
                    c_ulong, c_ulonglong, c_ushort, c_void_p, c_wchar, c_wchar_p, cast, create_string_buffer,
                    create_unicode_buffer, sizeof)
from ctypes import wintypes
import os
import platform
import socket
import winreg

kernel32 = WinDLL("kernel32", use_last_error=True)
ntdll = WinDLL("ntdll")
iphlpapi = WinDLL("iphlpapi")
pdh = WinDLL("pdh")

SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION_CLASS = 8
SYSTEM_PAGEFILE_INFORMATION_CLASS = 18
STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
PDH_FMT_DOUBLE = 0x00000200
PDH_FMT_NOCAP100 = 0x00008000
PDH_MORE_DATA = 0x800007D2
DRIVE_KINDS = {2: "removable", 3: "fixed", 4: "network", 6: "ramdisk"}  # 5 = optical, skipped
SEM_FAILCRITICALERRORS = 0x0001
IF_TYPE_ETHERNET = 6
IF_TYPE_WIFI = 71
IF_TYPE_LOOPBACK = 24
IF_OPER_UP = 1
UNKNOWN_SPEED = 0xFFFFFFFFFFFFFFFF
MAX_INTERFACES = 32
PLACEHOLDERS = {"to be filled by o.e.m.", "system manufacturer", "system product name", "default string",
                "not applicable", "none", "o.e.m."}
EDITIONS = {"Core": "Home", "Professional": "Pro", "ServerStandard": "Server Standard",
            "ServerDatacenter": "Server Datacenter"}


class FILETIME(Structure):
    _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]


class PROCESSOR_TIMES(Structure):  # SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION
    _fields_ = [("IdleTime", c_longlong), ("KernelTime", c_longlong), ("UserTime", c_longlong),
                ("DpcTime", c_longlong), ("InterruptTime", c_longlong), ("InterruptCount", c_ulong)]


class PAGEFILE(Structure):  # SYSTEM_PAGEFILE_INFORMATION
    _fields_ = [("NextEntryOffset", c_ulong), ("TotalSize", c_ulong), ("TotalInUse", c_ulong),
                ("PeakUsage", c_ulong), ("NameLength", c_ushort), ("NameMaximumLength", c_ushort),
                ("NameBuffer", c_void_p)]


class MEMORYSTATUSEX(Structure):
    _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD), ("ullTotalPhys", c_ulonglong),
                ("ullAvailPhys", c_ulonglong), ("ullTotalPageFile", c_ulonglong), ("ullAvailPageFile", c_ulonglong),
                ("ullTotalVirtual", c_ulonglong), ("ullAvailVirtual", c_ulonglong),
                ("ullAvailExtendedVirtual", c_ulonglong)]


class SYSTEM_INFO(Structure):
    _fields_ = [("wProcessorArchitecture", wintypes.WORD), ("wReserved", wintypes.WORD),
                ("dwPageSize", wintypes.DWORD), ("lpMinimumApplicationAddress", c_void_p),
                ("lpMaximumApplicationAddress", c_void_p), ("dwActiveProcessorMask", c_size_t),
                ("dwNumberOfProcessors", wintypes.DWORD), ("dwProcessorType", wintypes.DWORD),
                ("dwAllocationGranularity", wintypes.DWORD), ("wProcessorLevel", wintypes.WORD),
                ("wProcessorRevision", wintypes.WORD)]


class LOGICAL_PROCESSOR(Structure):  # SYSTEM_LOGICAL_PROCESSOR_INFORMATION
    _fields_ = [("ProcessorMask", c_size_t), ("Relationship", c_int), ("Reserved", c_ulonglong * 2)]


class PROCESS_MEMORY_COUNTERS(Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", c_size_t),
                ("WorkingSetSize", c_size_t), ("QuotaPeakPagedPoolUsage", c_size_t),
                ("QuotaPagedPoolUsage", c_size_t), ("QuotaPeakNonPagedPoolUsage", c_size_t),
                ("QuotaNonPagedPoolUsage", c_size_t), ("PagefileUsage", c_size_t), ("PeakPagefileUsage", c_size_t)]


class GUID(Structure):
    _fields_ = [("Data1", c_ulong), ("Data2", c_ushort), ("Data3", c_ushort), ("Data4", c_ubyte * 8)]


class MIB_IF_ROW2(Structure):
    _fields_ = [
        ("InterfaceLuid", c_ulonglong), ("InterfaceIndex", c_ulong), ("InterfaceGuid", GUID),
        ("Alias", c_wchar * 257), ("Description", c_wchar * 257),
        ("PhysicalAddressLength", c_ulong), ("PhysicalAddress", c_ubyte * 32),
        ("PermanentPhysicalAddress", c_ubyte * 32), ("Mtu", c_ulong), ("Type", c_ulong),
        ("TunnelType", c_int), ("MediaType", c_int), ("PhysicalMediumType", c_int), ("AccessType", c_int),
        ("DirectionType", c_int), ("InterfaceAndOperStatusFlags", c_ubyte), ("OperStatus", c_int),
        ("AdminStatus", c_int), ("MediaConnectState", c_int), ("NetworkGuid", GUID), ("ConnectionType", c_int),
        ("TransmitLinkSpeed", c_ulonglong), ("ReceiveLinkSpeed", c_ulonglong),
        ("InOctets", c_ulonglong), ("InUcastPkts", c_ulonglong), ("InNUcastPkts", c_ulonglong),
        ("InDiscards", c_ulonglong), ("InErrors", c_ulonglong), ("InUnknownProtos", c_ulonglong),
        ("InUcastOctets", c_ulonglong), ("InMulticastOctets", c_ulonglong), ("InBroadcastOctets", c_ulonglong),
        ("OutOctets", c_ulonglong), ("OutUcastPkts", c_ulonglong), ("OutNUcastPkts", c_ulonglong),
        ("OutDiscards", c_ulonglong), ("OutErrors", c_ulonglong), ("OutUcastOctets", c_ulonglong),
        ("OutMulticastOctets", c_ulonglong), ("OutBroadcastOctets", c_ulonglong), ("OutQLen", c_ulonglong),
    ]


class PDH_VALUE(Structure):  # PDH_FMT_COUNTERVALUE, read as a double
    _fields_ = [("CStatus", wintypes.DWORD), ("doubleValue", c_double)]


class PDH_ITEM(Structure):  # PDH_FMT_COUNTERVALUE_ITEM_W
    _fields_ = [("szName", c_wchar_p), ("FmtValue", PDH_VALUE)]


def _declare():
    kernel32.GetSystemTimes.argtypes = [POINTER(FILETIME)] * 3
    kernel32.GetSystemTimes.restype = wintypes.BOOL
    kernel32.GlobalMemoryStatusEx.argtypes = [POINTER(MEMORYSTATUSEX)]
    kernel32.GlobalMemoryStatusEx.restype = wintypes.BOOL
    kernel32.GetSystemInfo.argtypes = [POINTER(SYSTEM_INFO)]
    kernel32.GetTickCount64.restype = c_ulonglong
    kernel32.GetLogicalDriveStringsW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
    kernel32.GetLogicalDriveStringsW.restype = wintypes.DWORD
    kernel32.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetDriveTypeW.restype = wintypes.UINT
    kernel32.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD, c_void_p,
                                               c_void_p, c_void_p, wintypes.LPWSTR, wintypes.DWORD]
    kernel32.GetVolumeInformationW.restype = wintypes.BOOL
    kernel32.SetThreadErrorMode.argtypes = [wintypes.DWORD, POINTER(wintypes.DWORD)]
    kernel32.SetThreadErrorMode.restype = wintypes.BOOL
    kernel32.GetLogicalProcessorInformation.argtypes = [c_void_p, POINTER(wintypes.DWORD)]
    kernel32.GetLogicalProcessorInformation.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
    kernel32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
    ntdll.NtQuerySystemInformation.argtypes = [c_ulong, c_void_p, c_ulong, POINTER(c_ulong)]
    ntdll.NtQuerySystemInformation.restype = c_long
    iphlpapi.GetIfTable2.argtypes = [POINTER(c_void_p)]
    iphlpapi.GetIfTable2.restype = c_ulong
    iphlpapi.FreeMibTable.argtypes = [c_void_p]
    iphlpapi.FreeMibTable.restype = None
    pdh.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, c_size_t, POINTER(c_void_p)]
    pdh.PdhOpenQueryW.restype = c_long
    pdh.PdhAddEnglishCounterW.argtypes = [c_void_p, wintypes.LPCWSTR, c_size_t, POINTER(c_void_p)]
    pdh.PdhAddEnglishCounterW.restype = c_long
    pdh.PdhCollectQueryData.argtypes = [c_void_p]
    pdh.PdhCollectQueryData.restype = c_long
    pdh.PdhGetFormattedCounterValue.argtypes = [c_void_p, wintypes.DWORD, POINTER(wintypes.DWORD),
                                                POINTER(PDH_VALUE)]
    pdh.PdhGetFormattedCounterValue.restype = c_long
    pdh.PdhGetFormattedCounterArrayW.argtypes = [c_void_p, wintypes.DWORD, POINTER(wintypes.DWORD),
                                                 POINTER(wintypes.DWORD), c_void_p]
    pdh.PdhGetFormattedCounterArrayW.restype = c_long
    pdh.PdhCloseQuery.argtypes = [c_void_p]
    pdh.PdhCloseQuery.restype = c_long


_declare()


def _filetime(value: FILETIME) -> int:
    return (value.high << 32) | value.low


class Counters:
    """One PDH query, kept open: rate counters need the previous collection."""

    PATHS = {
        "performance": r"\Processor Information(_Total)\% Processor Performance",
        "base_mhz": r"\Processor Information(_Total)\Processor Frequency",
        "read": r"\PhysicalDisk(*)\Disk Read Bytes/sec",
        "write": r"\PhysicalDisk(*)\Disk Write Bytes/sec",
        "idle": r"\PhysicalDisk(*)\% Idle Time",
    }

    def __init__(self):
        self.query = c_void_p()
        self.counters = {}
        self.ok = pdh.PdhOpenQueryW(None, 0, byref(self.query)) == 0
        if not self.ok:
            return
        for key, path in self.PATHS.items():
            handle = c_void_p()
            if pdh.PdhAddEnglishCounterW(self.query, path, 0, byref(handle)) == 0:
                self.counters[key] = handle
        self.collected = False

    def collect(self):
        if self.ok and pdh.PdhCollectQueryData(self.query) == 0:
            self.collected = True

    def value(self, key: str):
        handle = self.counters.get(key)
        if handle is None:
            return None
        result = PDH_VALUE()
        if pdh.PdhGetFormattedCounterValue(handle, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, None, byref(result)) != 0:
            return None
        return result.doubleValue if result.CStatus in (0, 1) else None

    def values(self, key: str) -> dict:
        handle = self.counters.get(key)
        if handle is None:
            return {}
        size, count = wintypes.DWORD(0), wintypes.DWORD(0)
        status = pdh.PdhGetFormattedCounterArrayW(handle, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, byref(size),
                                                  byref(count), None)
        if (status & 0xFFFFFFFF) != PDH_MORE_DATA or not size.value:
            return {}
        buffer = create_string_buffer(size.value)
        if pdh.PdhGetFormattedCounterArrayW(handle, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, byref(size), byref(count),
                                            buffer) != 0:
            return {}
        items = cast(buffer, POINTER(PDH_ITEM))
        found = {}
        for index in range(count.value):
            item = items[index]
            if item.FmtValue.CStatus in (0, 1):
                found[item.szName] = item.FmtValue.doubleValue
        return found

    def close(self):
        if self.ok:
            pdh.PdhCloseQuery(self.query)
            self.ok = False


class WindowsBackend:
    platform = "Windows"

    def __init__(self):
        self.unsupported = {
            "cpu.load": "Windows has no load average",
            "cpu.temperature": "Windows exposes no CPU temperature without vendor tools or administrator WMI access",
        }
        self._system = None
        self._counters = Counters()
        if not self._counters.ok:
            self.unsupported["cpu.frequency"] = "Windows performance counters are unavailable"
            self.unsupported["storage.io"] = "Windows performance counters are unavailable"
        info = SYSTEM_INFO()
        kernel32.GetSystemInfo(byref(info))
        self._page = info.dwPageSize or 4096

    def tick(self):
        """Collects the PDH counters once per sample, before the readers use them."""
        self._counters.collect()

    def _missing(self, key: str, reason: str):
        self.unsupported[key] = reason
        return None

    # ---------- cpu ----------

    def cpu_times(self):
        idle, kernel, user = FILETIME(), FILETIME(), FILETIME()
        if not kernel32.GetSystemTimes(byref(idle), byref(kernel), byref(user)):
            return self._missing("cpu.percent", "GetSystemTimes failed")
        idle, kernel, user = _filetime(idle), _filetime(kernel), _filetime(user)
        return {"total": (kernel + user - idle, kernel + user), "cores": self._cores()}

    def _cores(self) -> list:
        count = max(os.cpu_count() or 1, 1)
        for _ in range(2):
            buffer = (PROCESSOR_TIMES * count)()
            returned = c_ulong(0)
            status = ntdll.NtQuerySystemInformation(SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION_CLASS, buffer,
                                                    sizeof(buffer), byref(returned))
            if (status & 0xFFFFFFFF) == STATUS_INFO_LENGTH_MISMATCH:
                count = max(returned.value // sizeof(PROCESSOR_TIMES), count + 1)
                continue
            if status != 0:
                return []
            cores = []
            for entry in buffer[:returned.value // sizeof(PROCESSOR_TIMES)]:
                everything = entry.KernelTime + entry.UserTime  # kernel time includes idle time
                cores.append((everything - entry.IdleTime, everything))
            return cores
        return []

    def load(self):
        return None

    def frequency(self):
        if not self._counters.ok:
            return None
        base = self._counters.value("base_mhz")
        performance = self._counters.value("performance")
        if not base:
            return self._missing("cpu.frequency", "the Processor Frequency counter is unavailable")
        current = base * performance / 100 if performance is not None else None
        return {"current_mhz": round(current) if current else None, "max_mhz": None, "base_mhz": round(base)}

    def temperatures(self):
        return None

    # ---------- memory ----------

    def memory(self):
        status = MEMORYSTATUSEX()
        status.dwLength = sizeof(MEMORYSTATUSEX)
        if not kernel32.GlobalMemoryStatusEx(byref(status)):
            return self._missing("memory", "GlobalMemoryStatusEx failed")
        swap_total, swap_used = self._page_files()
        return {"total": status.ullTotalPhys, "available": status.ullAvailPhys,
                "swap_total": swap_total, "swap_free": max(swap_total - swap_used, 0)}

    def _page_files(self):
        buffer = create_string_buffer(16 * 1024)
        returned = c_ulong(0)
        if ntdll.NtQuerySystemInformation(SYSTEM_PAGEFILE_INFORMATION_CLASS, buffer, sizeof(buffer),
                                          byref(returned)) != 0 or not returned.value:
            return 0, 0
        total = used = offset = 0
        while offset + sizeof(PAGEFILE) <= returned.value:
            entry = PAGEFILE.from_buffer(buffer, offset)
            total += entry.TotalSize
            used += entry.TotalInUse
            if not entry.NextEntryOffset:
                break
            offset += entry.NextEntryOffset
        return total * self._page, used * self._page

    # ---------- storage ----------

    def partitions(self):
        old = wintypes.DWORD()
        # no "insert a disk" dialog for an empty card reader or optical drive
        kernel32.SetThreadErrorMode(SEM_FAILCRITICALERRORS, byref(old))
        buffer = create_unicode_buffer(1024)
        length = kernel32.GetLogicalDriveStringsW(len(buffer), buffer)
        drives = [drive for drive in buffer[:length].split("\x00") if drive]
        found = []
        for drive in drives:
            kind = DRIVE_KINDS.get(kernel32.GetDriveTypeW(drive))
            if kind is None:
                continue
            name, filesystem = create_unicode_buffer(261), create_unicode_buffer(261)
            if not kernel32.GetVolumeInformationW(drive, name, 261, None, None, None, filesystem, 261):
                continue  # no media, or a disconnected network drive
            found.append({"mount": drive, "fs": filesystem.value or None, "kind": kind, "label": name.value or None})
        return found

    def usage(self, mount: str):
        import shutil
        try:
            usage = shutil.disk_usage(mount)
        except OSError:
            return None
        return {"total": usage.total, "used": usage.used, "free": usage.free}

    def disks(self):
        if not self._counters.ok or "read" not in self._counters.counters:
            return self._missing("storage.io", "the PhysicalDisk performance counters are unavailable")
        if not self._counters.collected:
            return None
        reads, writes, idle = (self._counters.values(key) for key in ("read", "write", "idle"))
        if not reads:
            return None  # rate counters have no value until their second collection
        disks = []
        for name in sorted(reads):
            if name == "_Total":
                continue
            busy = 100 - idle[name] if name in idle else None
            number, _, volumes = name.partition(" ")  # PDH names a disk "0 C: D:"
            disks.append({"name": f"Disk {number}" if number.isdigit() else name, "volumes": volumes or None,
                          "read_bps": round(reads[name]), "write_bps": round(writes.get(name, 0)),
                          "busy_percent": round(min(max(busy, 0), 100), 1) if busy is not None else None})
        return disks

    # ---------- network ----------

    def interfaces(self):
        table = c_void_p()
        if iphlpapi.GetIfTable2(byref(table)) != 0 or not table.value:
            return self._missing("network", "GetIfTable2 failed")
        try:
            count = cast(table, POINTER(c_ulong))[0]
            rows = cast(c_void_p(table.value + 8), POINTER(MIB_IF_ROW2))
            found, seen = [], set()
            for index in range(count):
                row = rows[index]
                flags = row.InterfaceAndOperStatusFlags
                hardware, filtered = bool(flags & 1), bool(flags & 2)
                if filtered or row.Type == IF_TYPE_LOOPBACK:
                    continue
                up = row.OperStatus == IF_OPER_UP
                traffic = row.InOctets + row.OutOctets
                if not hardware and not (up and traffic):
                    continue  # tunnels and virtual adapters nothing uses
                name = row.Alias or row.Description
                if name in seen:
                    continue
                seen.add(name)
                kind = ("wifi" if row.Type == IF_TYPE_WIFI else "ethernet" if row.Type == IF_TYPE_ETHERNET
                        else "other") if hardware else "virtual"
                speed = row.ReceiveLinkSpeed
                found.append({
                    "name": name, "kind": kind, "up": up,
                    "speed_mbps": speed // 1_000_000 if up and speed and speed != UNKNOWN_SPEED else None,
                    "rx_bytes": row.InOctets, "tx_bytes": row.OutOctets,
                    "rx_errors": row.InErrors, "tx_errors": row.OutErrors,
                    "rx_drops": row.InDiscards, "tx_drops": row.OutDiscards,
                })
        finally:
            iphlpapi.FreeMibTable(table)
        order = {"ethernet": 0, "wifi": 1, "other": 2, "virtual": 3}
        found.sort(key=lambda interface: (not interface["up"], order[interface["kind"]], interface["name"]))
        return found[:MAX_INTERFACES]

    # ---------- system ----------

    def system(self):
        if self._system is None:
            edition = platform.win32_edition() or ""
            self._system = {
                "os": " ".join(part for part in ("Windows", platform.release(), EDITIONS.get(edition, edition)) if part),
                "kernel": platform.version(),
                "architecture": platform.machine(),
                "hostname": socket.gethostname(),
                "cpu_model": _registry(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
                "physical_cores": _physical_cores(),
                "vendor": _registry(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer"),
                "model": _registry(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName"),
            }
        return {**self._system, "uptime_seconds": round(kernel32.GetTickCount64() / 1000)}

    def process_memory(self):
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = sizeof(PROCESS_MEMORY_COUNTERS)
        if kernel32.K32GetProcessMemoryInfo(kernel32.GetCurrentProcess(), byref(counters), counters.cb):
            return counters.WorkingSetSize
        return None

    def close(self):
        self._counters.close()


def _registry(path: str, name: str):
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value = str(winreg.QueryValueEx(key, name)[0]).strip()
    except OSError:
        return None
    return None if not value or value.lower() in PLACEHOLDERS else " ".join(value.split())


def _physical_cores():
    size = wintypes.DWORD(0)
    kernel32.GetLogicalProcessorInformation(None, byref(size))
    if not size.value:
        return None
    buffer = create_string_buffer(size.value)
    if not kernel32.GetLogicalProcessorInformation(buffer, byref(size)):
        return None
    entries = cast(buffer, POINTER(LOGICAL_PROCESSOR))
    return sum(1 for index in range(size.value // sizeof(LOGICAL_PROCESSOR)) if entries[index].Relationship == 0) or None
