"""status - health, hardware, network, services and history from the Status monitor.

Every command reads the monitor's snapshot (see monitor.py): the running
StarCore's latest sample, or - with no sampler running, as in the one-shot
CLI - a fresh one taken on the spot. History is read from the history file
and never creates it.
"""

from starcore.cli.runner import table
from starcore.cli.spec import Command, Option, Unavailable, UsageError

from ..history import PERIODS, SERIES
from ..monitor import monitor_for

NAMESPACE = "status"
SUMMARY = "Health, hardware, network, services and history of this machine"
DEFAULT = "snapshot"

READ = "status.read"
SPARK = "_.:-=+*#"  # ASCII, so any console can print it


def _monitor(ctx):
    satellite = ctx.engine.registry.get("Status")
    if satellite is None:
        raise Unavailable("the Status satellite is not loaded")
    return monitor_for(ctx.engine, satellite)


def _snapshot(ctx) -> dict:
    monitor = _monitor(ctx)
    # with no sampler, wait briefly for a second reading so CPU and throughput aren't empty
    return monitor.snapshot(settle=0.0 if monitor.running else 0.5)


def size(value) -> str:
    if value is None:
        return "-"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB", "PiB"):
        if abs(value) < 1024 or unit == "PiB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def rate(value) -> str:
    return "-" if value is None else f"{size(value)}/s"


def bits(value) -> str:
    """Network throughput in bits per second, as link speeds are given."""
    if value is None:
        return "-"
    value *= 8
    for unit in ("b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"):
        if abs(value) < 1000 or unit == "Tb/s":
            return f"{value:.0f} {unit}" if unit == "b/s" else f"{value:.1f} {unit}"
        value /= 1000


def pct(value) -> str:
    return "-" if value is None else f"{value:.1f}%"


def duration(seconds) -> str:
    if seconds is None:
        return "-"
    seconds = int(seconds)
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    return (f"{days}d " if days else "") + f"{hours}h {rest // 60}m"


def _warnings(health: dict) -> list:
    return [f"  {'!!' if warning['level'] == 'critical' else '! '} {warning['title']}"
            + (f" - {warning['detail']}" if warning["detail"] else "") for warning in health["warnings"]]


# ---------- status ----------

def snapshot(ctx):
    data = _snapshot(ctx)
    core = ctx.engine.status()
    return {**core, "health": data["health"], "sampling": data["sampling"], "interval": data["interval"],
            "cpu_percent": (data.get("cpu") or {}).get("percent"),
            "memory": {key: (data.get("memory") or {}).get(key) for key in ("total", "used", "percent")},
            "satellites_online": data["services"]["online"],
            "system": {key: (data.get("system") or {}).get(key) for key in ("os", "kernel", "hostname", "python",
                                                                          "uptime_seconds")}}


def _render_snapshot(data: dict) -> str:
    satellites, mission_control, health = data["satellites"], data["mission_control"], data["health"]
    count = len(health["warnings"])
    lines = [
        "StarCore status",
        "",
        f"Health           {health['state']}{f' ({count} warning' + ('s' if count != 1 else '') + ')' if count else ''}",
        f"Engine           {data['engine']}",
        f"State            {'running' if data['running'] else 'stopped'}",
        f"Uptime           {data['uptime_seconds']}s",
        f"Satellites       {satellites['total']} (native: {satellites['native']}, link: {satellites['link']}), "
        f"{data['satellites_online']} online",
        f"Commands         {data['commands']}",
        f"Mission Control  {mission_control['url'] if mission_control['running'] else 'not running'}",
        f"System           {data['system']['os']} (Python {data['system']['python']}), "
        f"up {duration(data['system']['uptime_seconds'])}",
        f"CPU              {pct(data['cpu_percent'])}",
        f"Memory           {pct(data['memory']['percent'])} of {size(data['memory']['total'])}",
        f"Sampling         {'every ' + str(data['interval']) + 's' if data['sampling'] else 'off (readings taken on request)'}",
    ]
    if count:
        lines += ["", "Warnings"] + _warnings(health)
    return "\n".join(lines)


# ---------- status hardware ----------

def hardware(ctx):
    data = _snapshot(ctx)
    return {key: data.get(key) for key in ("cpu", "memory", "storage", "system", "unsupported", "sampled_at")}


def _render_hardware(data: dict) -> str:
    cpu, memory, storage, system = data["cpu"] or {}, data["memory"], data["storage"] or {}, data["system"] or {}
    cores = f"{cpu.get('logical_cores') or '?'} threads" + (f", {cpu['physical_cores']} cores"
                                                           if cpu.get("physical_cores") else "")
    frequency = cpu.get("frequency") or {}
    load = cpu.get("load")
    temperature = cpu.get("temperature")
    lines = [
        f"System        {system.get('os')}, kernel {system.get('kernel')}, {system.get('architecture')}",
        f"Hardware      {' '.join(part for part in (system.get('vendor'), system.get('model')) if part) or '-'}",
        f"CPU           {cpu.get('model') or '-'} ({cores})",
        f"Usage         {pct(cpu.get('percent'))}",
        f"Frequency     {str(frequency.get('current_mhz')) + ' MHz' if frequency.get('current_mhz') else '-'}",
        f"Load          {' '.join(str(load[key]) for key in ('1m', '5m', '15m')) if load else 'unsupported'}",
        f"Temperature   {str(temperature['current']) + ' C' if temperature else 'unsupported'}",
    ]
    if cpu.get("per_core"):
        lines.append("Per core      " + " ".join(f"{value:.0f}" for value in cpu["per_core"]))
    if memory:
        swap = memory["swap"]
        lines += [f"Memory        {size(memory['used'])} of {size(memory['total'])} ({pct(memory['percent'])}), "
                  f"{size(memory['available'])} available",
                  f"Swap          {size(swap['used'])} of {size(swap['total'])}"
                  + (f" ({pct(swap['percent'])})" if swap["total"] else " (none configured)")]
    partitions = storage.get("partitions") or []
    if partitions:
        rows = [{"mount": item["mount"], "fs": item.get("fs") or "-", "kind": item["kind"], "size": size(item["total"]),
                 "free": size(item["free"]), "used": pct(item["percent"])} for item in partitions]
        lines += ["", table(rows, [("mount", "Mount"), ("fs", "FS"), ("kind", "Kind"), ("size", "Size"),
                                   ("free", "Free"), ("used", "Used")])]
    io = storage.get("io")
    if io:
        lines.append(f"\nDisk I/O      read {rate(io['read_bps'])}, write {rate(io['write_bps'])}")
    if data["unsupported"]:
        lines += ["", "Not available here"] + [f"  {key}: {reason}" for key, reason in data["unsupported"].items()]
    return "\n".join(lines)


# ---------- status network ----------

def network(ctx):
    data = _snapshot(ctx)
    if data.get("network") is None:
        raise Unavailable((data.get("unsupported") or {}).get("network", "network readings are unavailable"))
    return data["network"]


def _render_network(data: dict) -> str:
    rows = [{"name": item["name"], "kind": item["kind"], "state": "up" if item["up"] else "down",
             "speed": f"{item['speed_mbps']} Mb/s" if item.get("speed_mbps") else "-",
             "down": bits(item.get("rx_bps")), "up": bits(item.get("tx_bps")),
             "total": f"{size(item['rx_bytes'])} / {size(item['tx_bytes'])}",
             "errors": item["rx_errors"] + item["tx_errors"]} for item in data["interfaces"]]
    head = f"Throughput  down {bits(data['rx_bps'])}, up {bits(data['tx_bps'])}"
    return head + "\n\n" + (table(rows, [("name", "Interface"), ("kind", "Kind"), ("state", "State"),
                                         ("speed", "Link"), ("down", "Down"), ("up", "Up"),
                                         ("total", "Received / sent"), ("errors", "Errors")]) or "No interfaces.")


# ---------- status services ----------

def services(ctx):
    data = _snapshot(ctx)
    return {**data["services"], "health": data["health"]}


def _render_services(data: dict) -> str:
    engine = data["engine"]
    rows = [{**item, "service": "yes" if item["service"] else "no", "last_error": item["last_error"] or ""}
            for item in data["satellites"]]
    lines = [f"Engine        {engine['name']} {'running' if engine['running'] else 'stopped'}, "
             f"up {duration(engine['uptime_seconds'])}, satellite services "
             f"{'on' if engine['satellite_services'] else 'off'}",
             f"Satellites    {data['online']} of {data['total']} online", "",
             table(rows, [("name", "Satellite"), ("status", "Status"), ("service", "Service"),
                          ("last_error", "Last error")])]
    if data["dependencies"]:
        lines += ["", "Depends on"] + [f"  {item['satellite']} -> {item['needs']} ({item['kind']})"
                                       for item in data["dependencies"]]
    lines += ["", "Components"] + [f"  {'yes' if item['available'] else 'no ':<4} {item['name']:<13} {item['used_for']}"
                                   for item in data["components"]]
    if data["health"]["warnings"]:
        lines += ["", "Warnings"] + _warnings(data["health"])
    return "\n".join(lines)


# ---------- status history ----------

def _series(raw):
    if not raw:
        return None
    names = [name.strip() for name in raw.split(",") if name.strip()]
    unknown = [name for name in names if name not in SERIES]
    if unknown:
        raise UsageError(f"unknown series {', '.join(unknown)} (known: {', '.join(SERIES)})")
    return names


def history_command(ctx, period, series):
    monitor = _monitor(ctx)
    return monitor.history_query(period, _series(series), points=60)


def _render_history(data: dict) -> str:
    rows = []
    for name, line in data["series"].items():
        points = line["points"]
        if not points:
            continue
        averages = [point[1] for point in points]
        unit = line["unit"].replace("°", "")
        if name in ("net_rx", "net_tx"):
            show = bits
        elif unit == "B/s":
            show = rate
        else:
            show = (lambda value, unit=unit: f"{value:.1f}{(' ' + unit) if unit else ''}")
        low, high = min(averages), max(averages)
        spark = "".join(SPARK[min(int((value - low) / (high - low) * (len(SPARK) - 1)), len(SPARK) - 1)]
                        if high > low else SPARK[0] for value in averages)
        rows.append({"series": name, "latest": show(averages[-1]), "average": show(sum(averages) / len(averages)),
                     "peak": show(max(point[2] for point in points)), "trend": spark})
    if not rows:
        note = "" if data["sampling"] else " Status's sampler isn't running, so nothing is being recorded."
        return f"No history for the last {data['period']} yet.{note}"
    return (f"Last {data['period']} ({data['resolution']}s per point)\n\n"
            + table(rows, [("series", "Series"), ("latest", "Latest"), ("average", "Average"), ("peak", "Peak"),
                           ("trend", "Trend")]))


COMMANDS = [
    Command("snapshot", "Health, engine state, satellites, CPU and memory at a glance", snapshot, READ,
            render=_render_snapshot, examples=("status", "status --json")),
    Command("hardware", "CPU, memory, swap, partitions, disk I/O and temperatures", hardware, READ,
            render=_render_hardware, aliases=("metrics",), examples=("status hardware", "status hardware --json")),
    Command("network", "Network interfaces: state, link speed, throughput, traffic and errors", network, READ,
            render=_render_network, examples=("status network",)),
    Command("services", "The engine, every satellite, their dependencies and optional components", services, READ,
            render=_render_services, examples=("status services",)),
    Command("history", "Recorded history: latest, average, peak and trend per series", history_command, READ,
            options=(Option("period", "how far back", choices=tuple(PERIODS), default="24h", metavar="period"),
                     Option("series", f"comma-separated series (default: all of {', '.join(SERIES)})",
                            metavar="names")),
            render=_render_history, examples=("status history --period 24h", "status history --period 7d "
                                              "--series cpu,memory --json")),
]
