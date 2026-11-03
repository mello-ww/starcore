"""Warnings and the overall health state, derived only from real readings.

CPU and memory warnings use the average of the last minute, so a short
spike never raises one; the rest use the latest reading. A reading that
isn't available raises nothing.
"""

LEVELS = {"critical": 0, "warning": 1}

# (warning at, critical at)
CPU = (90.0, 98.0)
MEMORY = (90.0, 97.0)
SWAP = (80.0, 95.0)
STORAGE = (90.0, 97.0)
TEMPERATURE = (85.0, 95.0)


def _level(value, limits):
    if value is None:
        return None
    if value >= limits[1]:
        return "critical"
    if value >= limits[0]:
        return "warning"
    return None


def evaluate(snapshot: dict, averages: dict, services: dict = None, sampler: dict = None) -> dict:
    warnings = []

    def add(key, level, title, detail):
        if level:
            warnings.append({"id": key, "level": level, "title": title, "detail": detail})

    cpu = averages.get("cpu")
    add("cpu", _level(cpu, CPU), "CPU is busy", f"{cpu:.0f}% on average over the last minute" if cpu is not None else "")
    memory = averages.get("memory")
    add("memory", _level(memory, MEMORY), "Memory is almost full",
        f"{memory:.0f}% in use on average over the last minute" if memory is not None else "")

    swap = ((snapshot.get("memory") or {}).get("swap") or {}).get("percent")
    add("swap", _level(swap, SWAP), "Swap is almost full", f"{swap:.0f}% in use" if swap is not None else "")

    temperature = ((snapshot.get("cpu") or {}).get("temperature") or {}).get("current")
    add("temperature", _level(temperature, TEMPERATURE), "CPU is hot",
        f"{temperature:.0f} °C" if temperature is not None else "")

    storage = snapshot.get("storage") or {}
    for partition in storage.get("partitions") or []:
        if partition.get("kind") not in ("fixed", "removable", "network"):
            continue
        used = partition.get("percent")
        add(f"storage:{partition['mount']}", _level(used, STORAGE), f"{partition['mount']} is almost full",
            f"{used:.1f}% used, {_bytes(partition.get('free'))} free" if used is not None else "")
    if storage.get("stale"):
        add("storage:stale", "warning", "Storage figures are out of date",
            "a drive or network share is not answering")

    engine = (services or {}).get("engine") or {}
    if services and not engine.get("running"):
        # read by the command line while StarCore itself is stopped: every
        # service is down for that one reason
        add("engine", "warning", "StarCore is not running", "these readings were taken on request")
    elif services:
        for satellite in services.get("satellites") or []:
            if satellite["status"] == "error":
                add(f"satellite:{satellite['name']}", "critical", f"{satellite['name']} reported an error",
                    satellite.get("last_error") or "its last start or stop failed")
            elif satellite["status"] == "stopped" and satellite.get("enabled"):
                add(f"satellite:{satellite['name']}", "warning", f"{satellite['name']} is not running",
                    "it is enabled, but its service is stopped")
        mission_control = engine.get("mission_control") or {}
        if mission_control.get("enabled") and not mission_control.get("running"):
            add("mission-control", "warning", "Mission Control is not running", "it is enabled but not serving")

    if sampler and sampler.get("stalled"):
        add("sampler", "warning", "Status sampling has stopped", "readings and history are not being updated")

    warnings.sort(key=lambda warning: LEVELS[warning["level"]])
    state = "critical" if any(item["level"] == "critical" for item in warnings) else \
        "warning" if warnings else "ok"
    return {"state": state, "warnings": warnings}


def _bytes(value) -> str:
    if value is None:
        return "an unknown amount"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB", "PiB"):
        if value < 1024 or unit == "PB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
