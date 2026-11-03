"""satellites - list and inspect Satellites, and run their generic lifecycle controls.

Lifecycle goes through StarCore.set_satellite_enabled() / reload_satellite(),
the same calls Mission Control's enable/disable/reload buttons make.
"""

from ...core import SatelliteError
from ..runner import render_value, table
from ..spec import Argument, Command, CommandError, NotFound

NAMESPACE = "satellites"
SUMMARY = "List and inspect Satellites; enable, disable or reload one"
DEFAULT = "list"
ALIASES = ("satellite",)

READ = "engine.read"
MANAGE = "engine.manage"


def _summary(engine, satellite) -> dict:
    from ...api.payloads import satellite_status

    commands = [name for name, entry in engine.command_registry.all().items()
                if entry["source"] == satellite.manifest.name]
    return {
        "name": satellite.manifest.name,
        "version": satellite.manifest.version,
        "type": satellite.type,
        "enabled": satellite.enabled,
        "status": satellite_status(engine, satellite),
        "service": satellite.has_service,
        "commands": commands,
        "section_of": satellite.manifest.section_of,
        "last_error": satellite.last_error,
    }


def _find(engine, name: str):
    satellite = engine.registry.get(name)
    if satellite is None:
        known = ", ".join(item.manifest.name for item in engine.registry.all())
        raise NotFound(f"unknown satellite '{name}' (known: {known})")
    return satellite


def list_satellites(ctx):
    return {"satellites": [_summary(ctx.engine, satellite) for satellite in ctx.engine.registry.all()]}


def _render_list(data: dict) -> str:
    rows = [{**item, "commands": ", ".join(item["commands"]) or "-"} for item in data["satellites"]]
    return table(rows, [("name", "Name"), ("version", "Version"), ("type", "Type"), ("status", "Status"),
                        ("commands", "Commands")])


def show(ctx, name):
    satellite = _find(ctx.engine, name)
    return {**_summary(ctx.engine, satellite), "author": satellite.manifest.author,
            "description": satellite.manifest.description, "state": satellite.state(ctx.engine)}


def _render_show(data: dict) -> str:
    details = {key: value for key, value in data.items() if key != "state"}
    text = render_value({**details, "commands": ", ".join(details["commands"]) or "-"})
    if data["state"]:
        text += "\n\nState\n" + "\n".join(f"  {line}" for line in render_value(data["state"]).splitlines())
    return text


def _lifecycle(ctx, name: str, action: str) -> dict:
    engine = ctx.engine
    satellite = _find(engine, name)
    try:
        if action == "reload":
            result = engine.reload_satellite(satellite.manifest.name)
        else:
            result = engine.set_satellite_enabled(satellite.manifest.name, action == "enable")
    except SatelliteError as error:
        raise NotFound(str(error))
    if result["error"]:
        raise CommandError(result["error"])
    return _summary(engine, result["satellite"])


def _render_lifecycle(verb: str):
    return lambda data: f"{data['name']} {verb} - now {data['status']}."


NAME = Argument("name", "the satellite's name, e.g. Status (any letter case)")

COMMANDS = [
    Command("list", "List every Satellite with its state and commands", list_satellites, READ,
            render=_render_list, examples=("satellites", "satellites list --json")),
    Command("show", "Show one Satellite's details and published state", show, READ, arguments=(NAME,),
            render=_render_show, examples=("satellites show Status",)),
    Command("enable", "Enable a Satellite and start its service", lambda ctx, name: _lifecycle(ctx, name, "enable"),
            MANAGE, arguments=(NAME,), mutates=True, requires_live=True, render=_render_lifecycle("enabled"),
            examples=("satellites enable Status",)),
    Command("disable", "Stop a Satellite's service and disable it",
            lambda ctx, name: _lifecycle(ctx, name, "disable"), MANAGE, arguments=(NAME,), mutates=True,
            requires_live=True, confirm="Disable this Satellite? Its features stop until it is enabled again.",
            render=_render_lifecycle("disabled"), examples=("satellites disable Status --yes",)),
    Command("reload", "Reload a Satellite from disk and restart it",
            lambda ctx, name: _lifecycle(ctx, name, "reload"), MANAGE, arguments=(NAME,), mutates=True,
            requires_live=True, confirm="Reload this Satellite? Its service restarts.",
            render=_render_lifecycle("reloaded"), examples=("satellites reload Status --yes",)),
]
