"""What Status's ui.json binds to: the monitor's snapshot, shaped for display.

UI contract documents have no expression language (docs/ui-contract.md,
"Bindings"): a Satellite returns what it wants shown. This module is that
step for Status. It measures nothing and keeps no state - every value comes
from the same cached snapshot, history and diagnostics the other routes
return - and it only decides presentation:

- which reading a tile shows (the fullest drive, the interfaces that are up),
- the tone of each reading, from the same thresholds health.py warns at,
- lines of text built from several values, formatted with the contract's
  own rules (format_value) so they read like the values the clients format,
- what to say where a machine can't provide a reading.

Raw numbers stay numbers wherever a client formats or draws them itself
(percentages, rates, sizes, times, charts), so each platform keeps its own
locale-independent formatting from the shared contract.
"""

from starcore.ui_contract import format_value

from . import health
from .history import TIERS

HEALTH_LABELS = {"ok": "Healthy", "warning": "Warning", "critical": "Critical"}
HEALTH_TONES = {"ok": "ok", "warning": "warn", "critical": "danger"}
SATELLITE_STATES = {"running": ("Running", "ok"), "stopped": ("Stopped", "warn"), "disabled": ("Disabled", "neutral"),
                    "error": ("Error", "danger")}
DASH = "—"
# history charts that may have nothing to show, and the `unsupported` key that says why
OPTIONAL_CHARTS = (("Network", "network"), ("Disk throughput", "storage.io"), ("Load average", "cpu.load"),
                   ("CPU temperature", "cpu.temperature"))


def tone(value, limits) -> str:
    """A reading's tone from health.py's (warning, critical) thresholds."""
    level = health._level(value, limits)
    return {"critical": "danger", "warning": "warn"}.get(level, "neutral")


def size(value) -> str:
    return format_value(value, "bytes")


def plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def frequency(mhz) -> str:
    if not mhz:
        return DASH
    return f"{format_value(mhz / 1000, 'number')} GHz" if mhz >= 1000 else f"{mhz:.0f} MHz"


def link_speed(mbps) -> str:
    if not mbps or mbps <= 0:
        return DASH
    return f"{format_value(mbps / 1000, 'number')} Gb/s" if mbps >= 1000 else f"{mbps:.0f} Mb/s"


def unsupported(snapshot: dict, key: str, fallback: str = "Not available on this machine") -> str:
    return (snapshot.get("unsupported") or {}).get(key) or fallback


def fullest(partitions: list):
    local = [item for item in partitions or [] if item.get("kind") in ("fixed", "removable")
             and item.get("percent") is not None]
    return max(local, key=lambda item: item["percent"], default=None)


def describe(snapshot: dict) -> dict:
    """The whole display model: header, overview, hardware, network, services."""
    return {
        **header(snapshot),
        "overview": overview(snapshot),
        "hardware": hardware(snapshot),
        "network": network(snapshot),
        "services": services(snapshot),
        "history_notes": history_notes(snapshot),
    }


def header(snapshot: dict) -> dict:
    node = (snapshot.get("node") or {}).get("name")
    state = snapshot["health"]["state"]
    count = len(snapshot["health"]["warnings"])
    sampling = f"Sampling every {snapshot['interval']} s" if snapshot.get("sampling") \
        else "Sampling off - readings are taken on request"
    return {
        "eyebrow": f"Status · {node}" if node else "Status",
        "sampled_at": snapshot.get("sampled_at"),
        "sampling_text": sampling,
        "health": {"state": state, "label": HEALTH_LABELS.get(state, state), "tone": HEALTH_TONES.get(state, "neutral"),
                   "detail": plural(count, "warning") if count else None},
        "warnings": [{"title": warning["title"], "detail": warning.get("detail") or None,
                      "level": "Critical" if warning["level"] == "critical" else "Warning",
                      "tone": "danger" if warning["level"] == "critical" else "warn"}
                     for warning in snapshot["health"]["warnings"]],
    }


def overview(snapshot: dict) -> dict:
    cpu = snapshot.get("cpu") or {}
    memory = snapshot.get("memory")
    net = snapshot.get("network")
    drive = fullest((snapshot.get("storage") or {}).get("partitions"))
    state = snapshot.get("services") or {}
    engine = state.get("engine") or {}
    system = snapshot.get("system") or {}
    threads = None
    if cpu.get("logical_cores"):
        threads = plural(cpu["logical_cores"], "thread")
        current = (cpu.get("frequency") or {}).get("current_mhz")
        if current:
            threads += f" · {frequency(current)}"
    return {
        "cpu": {"percent": cpu.get("percent"), "tone": tone(cpu.get("percent"), health.CPU), "detail": threads},
        "memory": {
            "percent": memory and memory.get("percent"),
            "tone": tone(memory and memory.get("percent"), health.MEMORY),
            "detail": f"{size(memory['used'])} of {size(memory['total'])}" if memory else unsupported(snapshot, "memory"),
        },
        "storage": {
            "percent": drive and drive["percent"],
            "tone": tone(drive and drive["percent"], health.STORAGE),
            "detail": f"{drive['mount']} · {size(drive['free'])} free" if drive else "No drives were read",
        },
        "network": {
            "rx_bps": net and net.get("rx_bps"),
            "detail": f"down · {format_value(net.get('tx_bps'), 'bitrate')} up" if net
            else unsupported(snapshot, "network"),
        },
        "satellites": {"value": f"{state.get('online', 0)}/{state.get('total', 0)}", "detail": "online"},
        "uptime": {"seconds": system.get("uptime_seconds"),
                   "detail": f"StarCore {format_value(engine.get('uptime_seconds'), 'duration')}"},
        "history_note": None if snapshot.get("sampling") else "History is recorded while the Status service runs",
    }


def hardware(snapshot: dict) -> dict:
    cpu = snapshot.get("cpu") or {}
    memory = snapshot.get("memory")
    storage = snapshot.get("storage") or {}
    system = snapshot.get("system") or {}
    freq = cpu.get("frequency")
    load = cpu.get("load")
    temperature = cpu.get("temperature")
    sensors = (temperature or {}).get("sensors") or []

    swap = (memory or {}).get("swap") or {}
    io = storage.get("io")
    return {
        "cpu": {
            "model": cpu.get("model") or "Unknown processor",
            "percent": cpu.get("percent"),
            "cores": f"{cpu.get('logical_cores') or DASH} / {cpu.get('physical_cores') or DASH}",
            "frequency": frequency(freq.get("current_mhz")) if freq else DASH,
            "frequency_detail": (f"base {frequency(freq['base_mhz'])}" if freq.get("base_mhz")
                                 else f"max {frequency(freq['max_mhz'])}" if freq.get("max_mhz") else None)
            if freq else unsupported(snapshot, "cpu.frequency"),
            "load": f"{load['1m']} · {load['5m']} · {load['15m']}" if load else DASH,
            "load_detail": "1, 5 and 15 minutes" if load else unsupported(snapshot, "cpu.load"),
            "temperature": temperature.get("current") if temperature else None,
            "temperature_detail": plural(len(sensors), "sensor") if temperature
            else unsupported(snapshot, "cpu.temperature"),
            "per_core": cpu.get("per_core") or [],
            "sensors": [{"label": sensor.get("label"), "celsius": sensor.get("celsius")} for sensor in sensors]
            if len(sensors) > 1 else [],
        },
        "memory": {
            "available": memory is not None,
            "unavailable": None if memory else unsupported(snapshot, "memory"),
            "title": f"{size(memory['used'])} of {size(memory['total'])} in use" if memory else None,
            "percent": memory and memory.get("percent"),
            "tone": tone(memory and memory.get("percent"), health.MEMORY),
            "free": memory and memory.get("available"),
            "swap": f"{size(swap['used'])} of {size(swap['total'])}" if swap.get("total") else "None configured",
            "swap_detail": format_value(swap.get("percent"), "percent") if swap.get("total") else None,
            "swap_percent": swap.get("percent") if swap.get("total") else None,
            "swap_tone": tone(swap.get("percent"), health.SWAP),
            "has_swap": bool(swap.get("total")),
        },
        "storage": {
            "stale": "A drive is not answering; these figures are from its last reading." if storage.get("stale")
            else None,
            "partitions": [{
                "drive": f"{item['mount']} · {item['label']}" if item.get("label") else item["mount"],
                "kind": item.get("kind"), "fs": item.get("fs"), "percent": item.get("percent"),
                "tone": tone(item.get("percent"), health.STORAGE), "total": item.get("total"), "free": item.get("free"),
            } for item in storage.get("partitions") or []],
            "disks": [{"name": disk.get("name"), "volumes": disk.get("volumes") or DASH, "read_bps": disk.get("read_bps"),
                       "write_bps": disk.get("write_bps"), "busy": disk.get("busy_percent")}
                      for disk in (io or {}).get("disks") or []],
            "disks_empty": "Disk activity appears after the second reading." if io
            else unsupported(snapshot, "storage.io"),
        },
        "system": {
            "os": system.get("os") or DASH,
            "kernel": system.get("kernel") or DASH,
            "architecture": system.get("architecture") or DASH,
            "hardware": " ".join(part for part in (system.get("vendor"), system.get("model")) if part) or DASH,
            "hostname": system.get("hostname") or DASH,
            "boot_time": system.get("boot_time"),
            "uptime": f"up {format_value(system['uptime_seconds'], 'duration')}"
            if system.get("uptime_seconds") is not None else None,
        },
    }


def network(snapshot: dict) -> dict:
    net = snapshot.get("network")
    if not net:
        return {"available": False, "unavailable": unsupported(snapshot, "network")}
    interfaces = net.get("interfaces") or []
    up = sum(1 for item in interfaces if item.get("up"))
    return {
        "available": True,
        "unavailable": None,
        "rx_bps": net.get("rx_bps"),
        "tx_bps": net.get("tx_bps"),
        "connected": f"{up}/{len(interfaces)}",
        "interfaces": [{
            "name": item.get("name"), "kind": item.get("kind"),
            "state": "Up" if item.get("up") else "Down", "tone": "ok" if item.get("up") else "neutral",
            "link": link_speed(item.get("speed_mbps")), "rx_bps": item.get("rx_bps"), "tx_bps": item.get("tx_bps"),
            "rx_bytes": item.get("rx_bytes"), "tx_bytes": item.get("tx_bytes"),
            "errors": f"{(item.get('rx_errors') or 0) + (item.get('tx_errors') or 0)} / "
                      f"{(item.get('rx_drops') or 0) + (item.get('tx_drops') or 0)}",
        } for item in interfaces],
    }


def services(snapshot: dict) -> dict:
    state = snapshot.get("services") or {}
    engine = state.get("engine") or {}
    mission_control = engine.get("mission_control") or {}
    satellites = []
    for item in state.get("satellites") or []:
        label, item_tone = SATELLITE_STATES.get(item["status"], (item["status"], "neutral"))
        satellites.append({"name": item["name"], "status": label, "tone": item_tone,
                           "service": "Yes" if item.get("service") else "No", "version": item.get("version"),
                           "commands": ", ".join(item.get("commands") or []) or DASH,
                           "error": item.get("last_error") or DASH})
    return {
        "engine": {
            "title": f"{engine.get('name', 'StarCore')} · {'running' if engine.get('running') else 'stopped'}",
            "uptime": engine.get("uptime_seconds"),
            "mission_control": ("Running" if mission_control.get("running") else "Not running")
            if mission_control.get("enabled") else "Disabled",
            "satellite_services": "On" if engine.get("satellite_services") else "Off",
            "commands": engine.get("commands"),
        },
        "checks": [{"check": str(check.get("check", "")).capitalize(), "state": "Passing" if check.get("ok") else "Failing",
                    "tone": "ok" if check.get("ok") else "danger", "detail": check.get("detail")}
                   for check in state.get("checks") or []],
        "satellites_title": f"Satellites · {state.get('online', 0)} of {state.get('total', 0)} online",
        "satellites": satellites,
        "dependencies": [{"satellite": item["satellite"], "needs": item["needs"],
                          "how": "shown inside it" if item.get("kind") == "section" else item.get("kind")}
                         for item in state.get("dependencies") or []],
        "components": [{"name": item["name"], "state": "Installed" if item.get("available") else "Not installed",
                        "tone": "ok" if item.get("available") else "neutral", "used": item.get("used_for")}
                       for item in state.get("components") or []],
    }


def history_notes(snapshot: dict) -> dict:
    """The History page's notes - its charts bind to /history directly."""
    return {
        "empty": "No samples in this period yet" if snapshot.get("sampling")
        else "Nothing recorded: the Status service is not running",
        "unsupported": [{"title": title, "reason": snapshot["unsupported"][key]}
                        for title, key in OPTIONAL_CHARTS if key in (snapshot.get("unsupported") or {})],
    }


def diagnostics(data: dict) -> dict:
    """The Diagnostics page: the /diagnostics answer, with the tier table joined."""
    sampler = data.get("sampler") or {}
    store = data.get("history") or {}
    process = data.get("process") or {}
    rows = store.get("rows") or {}
    supported = data.get("unsupported") or {}
    return {
        "sampler": {
            "state": ("Stalled" if sampler.get("stalled") else "Running") if sampler.get("running") else "Not running",
            "interval": sampler.get("interval"),
            "samples": sampler.get("samples"),
            "collect": f"{sampler['last_ms']} ms" if sampler.get("last_ms") is not None else DASH,
            "collect_detail": f"average {sampler['average_ms']} ms" if sampler.get("average_ms") is not None else None,
            "errors": sampler.get("errors"),
            "last_error": sampler.get("last_error"),
            "started_at": sampler.get("started_at"),
        },
        "process": {"cpu": process.get("cpu_percent"), "memory": process.get("memory"),
                    "python": data.get("python") or DASH, "platform": data.get("platform") or DASH},
        "store": {"bytes": store.get("bytes"), "state": store.get("problem") or "Healthy"},
        "tiers": [{"tier": name, "bucket": bucket, "kept": kept, "rows": rows.get(name)} for name, bucket, kept in TIERS],
        "unsupported": [{"reading": key, "reason": reason} for key, reason in supported.items()],
        "all_supported": "Every reading is available here." if not supported else None,
        "raw": data,
    }


def widget(summary: dict) -> dict:
    """The extra keys Status publishes with its state (state.py) for its Home widget."""
    state = summary.get("health")
    online, total = summary.get("satellites_online"), summary.get("satellites_total")
    shown = (summary.get("warnings") or [])[:3]
    return {
        "health_label": HEALTH_LABELS.get(state, "No readings yet"),
        "health_tone": HEALTH_TONES.get(state, "neutral"),
        "health_detail": plural(summary.get("warning_count") or 0, "warning") if summary.get("warning_count") else None,
        "cpu_tone": tone(summary.get("cpu_percent"), health.CPU),
        "memory_tone": tone(summary.get("memory_percent"), health.MEMORY),
        "satellites": f"{online}/{total}" if isinstance(total, int) else None,
        "warning_items": [{"title": title, "tone": "danger" if index == 0 and state == "critical" else "warn"}
                          for index, title in enumerate(shown)],
    }
