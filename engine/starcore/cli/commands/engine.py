"""engine - version, status, uptime, health and lifecycle of this StarCore."""

from datetime import datetime, timezone
from threading import Timer
import platform
import time

from ..runner import table
from ..spec import Command, CommandError, Unavailable
from .version import VERSION

NAMESPACE = "engine"
SUMMARY = "Version, status, uptime, health and lifecycle of this StarCore"
DEFAULT = "status"

READ = "engine.read"
MANAGE = "engine.manage"


def version(ctx):
    return {"starcore": VERSION, "python": platform.python_version(), "platform": platform.system()}


def status(ctx):
    return ctx.engine.status()


def _render_status(data: dict) -> str:
    satellites = data["satellites"]
    mission_control = data["mission_control"]
    return "\n".join([
        "StarCore status",
        "",
        f"Engine           {data['engine']}",
        f"State            {'running' if data['running'] else 'stopped'}",
        f"Uptime           {data['uptime_seconds']}s",
        f"Satellites       {satellites['total']} (native: {satellites['native']}, link: {satellites['link']})",
        f"Commands         {data['commands']}",
        f"Mission Control  {mission_control['url'] if mission_control['running'] else 'not running'}",
    ])


def uptime(ctx):
    engine = ctx.engine
    started = getattr(engine, "_started_at", None)
    running = bool(ctx.live and started)
    return {
        "running": running,
        "uptime_seconds": round(time.time() - started, 1) if running else 0.0,
        "started_at": datetime.fromtimestamp(started, tz=timezone.utc).isoformat(timespec="seconds")
        if running else None,
    }


def _render_uptime(data: dict) -> str:
    if not data["running"]:
        return "StarCore is not running."
    seconds = int(data["uptime_seconds"])
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, seconds = divmod(rest, 60)
    readable = (f"{days}d " if days else "") + f"{hours:02}:{minutes:02}:{seconds:02}"
    return f"Up {readable} (since {data['started_at']})"


def health(ctx):
    """Exit 0 when healthy, 1 when something is failing, 5 when StarCore isn't running."""
    data = ctx.engine.health()
    if not ctx.live:
        raise Unavailable("StarCore is not running", data=data)
    if not data["healthy"]:
        failing = ", ".join(check["check"] for check in data["checks"] if not check["ok"])
        raise CommandError(f"unhealthy: {failing}", data=data)
    return data


def _render_health(data: dict) -> str:
    rows = [{**check, "ok": "ok" if check["ok"] else "FAIL"} for check in data["checks"]]
    return "Healthy\n\n" + table(rows, [("ok", "State"), ("check", "Check"), ("detail", "Detail")])


def restart(ctx):
    # deferred so this command's own output reaches the caller first -
    # request_restart() stops every service, the API included
    Timer(0.5, ctx.engine.request_restart).start()
    return {"restarting": True}


def stop(ctx):
    Timer(0.5, ctx.engine.stop).start()
    return {"stopping": True}


COMMANDS = [
    Command("version", "Show the StarCore, Python and platform versions", version, READ,
            examples=("engine version", "engine version --json")),
    Command("status", "Show engine state, satellites, commands and Mission Control", status, READ,
            render=_render_status, examples=("engine status", "engine status --json")),
    Command("uptime", "Show how long StarCore has been running", uptime, READ, render=_render_uptime),
    Command("health", "Check the engine, Mission Control and every satellite", health, READ,
            description="Checks the engine, Mission Control and every satellite. Exits 0 when everything is "
                        "healthy, 1 when a check fails and 5 when StarCore is not running - suitable for a "
                        "monitoring script.",
            render=_render_health, examples=("engine health", "engine health --json")),
    Command("restart", "Restart StarCore (every service stops and starts again)", restart, MANAGE,
            mutates=True, requires_live=True, confirm="Restart StarCore now?",
            render=lambda data: "StarCore is restarting.", examples=("engine restart --yes",)),
    Command("stop", "Shut StarCore down", stop, MANAGE, mutates=True, requires_live=True,
            confirm="Shut StarCore down now?", render=lambda data: "StarCore is shutting down.",
            examples=("engine stop --yes",)),
]
