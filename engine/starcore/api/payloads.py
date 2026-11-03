from .. import engine_config
from ..cli import runner


def describe_satellite(engine, satellite) -> dict:
    return {
        "name": satellite.manifest.name,
        "version": satellite.manifest.version,
        "author": satellite.manifest.author,
        "description": satellite.manifest.description,
        "icon": satellite.manifest.icon,
        # set when this satellite's interface is a section of another
        # satellite's page - see SatelliteManifest.section_of
        "section_of": satellite.manifest.section_of,
        "type": satellite.type,
        "enabled": bool(satellite.config.get("enabled", True)),
        "status": satellite_status(engine, satellite),
        "commands": describe_commands(engine, source=satellite.manifest.name),
        "state": satellite.state(engine),
        "page": satellite.page,
        # a satellite exposes configuration purely by naming one of its own
        # routes "configuration" (see docs/satellites.md) - the Core only ever
        # checks for that name, so it never needs to know what any satellite's
        # settings actually are
        "configurable": "configuration" in satellite.routes,
        # same convention, for a mobile interface instead of a settings panel -
        # see "Exposing a mobile interface" in docs/satellites.md. This is the
        # entire signal the mobile app uses to decide whether a satellite gets
        # an entry it can open on the Satellites screen, or is listed with no
        # interface of its own yet.
        "mobile_ui": "mobile" in satellite.routes,
    }


def satellite_status(engine, satellite) -> str:
    """One of "running" / "stopped" / "disabled" / "error", entirely generic.

    - "error": the satellite's last start/stop hook failed. Takes priority
      over everything else so a broken satellite is never shown as healthy.
    - "disabled": turned off via its own config - see Satellite.enabled.
    - "running": either it has no background service at all (has_service is
      False, so being enabled *is* the whole story), or it does and its last
      known state is running.
    - "stopped": it has a service, is enabled, but isn't currently running -
      either because satellite services are globally disabled
      (engine.satellite_services_enabled) or its stop hook last ran (or it
      simply hasn't started yet).
    """
    if satellite.last_error:
        return "error"
    if not satellite.enabled:
        return "disabled"
    if not satellite.has_service:
        return "running"
    if not engine.satellite_services_enabled:
        return "stopped"
    return "running" if satellite.running else "stopped"


def describe_satellites(engine) -> list:
    return [describe_satellite(engine, satellite) for satellite in engine.registry.all()]


def describe_commands(engine, source=None) -> list:
    commands = []

    for name, entry in engine.command_registry.all().items():
        if source is not None and entry["source"] != source:
            continue

        metadata = entry["metadata"]
        described = {
            "name": name,
            "source": entry["source"],
            "description": metadata.get("description", ""),
            "usage": metadata.get("usage", ""),
            "category": metadata.get("category", ""),
            "aliases": metadata.get("aliases", []),
        }
        namespace = entry.get("namespace")
        if namespace is not None:
            # the typed schema of each subcommand, limited to what a remote
            # console may actually run - see starcore/cli/runner.py
            context = runner.remote_context(engine)
            described["commands"] = [command.schema() for command in namespace.unique()
                                     if runner.refusal(engine, command, namespace, context) is None]
        commands.append(described)

    return commands


def describe_configuration(engine) -> dict:
    settings = [{**setting, **_live_state(engine, setting)} for setting in engine_config.describe(engine.config)]

    return {
        "settings": settings,
        "restart_required": any(setting["pending_restart"] for setting in settings),
    }


def _live_state(engine, setting: dict) -> dict:
    """Whether what's actually running still matches the saved value.

    The Core reads [server] once at startup, so a value saved after that keeps
    running under the old one until StarCore restarts - this is what lets the
    API (and the CLI and Mission Control) say so truthfully instead of just
    assuming a save took effect.
    """
    live = None
    if setting["section"] == "server":
        live = {
            "host": engine.api.host,
            "port": engine.api.port,
            "enabled": engine.mission_control_enabled,
            "https_enabled": engine.api.https_enabled,
            "https_cert": str(engine.api.https_cert) if engine.api.https_cert else "",
            "https_key": str(engine.api.https_key) if engine.api.https_key else "",
        }.get(setting["key"])

    # port 0 means "let the OS choose one" - the live port then never equals the
    # configured value by design, which isn't a change waiting on a restart
    if setting["key"] == "port" and setting["value"] == 0:
        return {"live_value": live, "pending_restart": False}

    return {"live_value": live, "pending_restart": live is not None and live != setting["value"]}


def execute(engine, command: str, token: str = "") -> dict:
    """Runs a console command for a signed-in Mission Control or mobile session.

    Same parser, output and exit codes as the terminal, but as a remote
    caller: only read-only commands and those that opt in to remote use
    (see starcore/cli/runner.py) run here - a state-changing command never
    becomes reachable from a browser just because it exists.
    """
    try:
        outcome = engine.run_command(command, runner.remote_context(engine, token))
    except Exception as error:
        return {"command": command, "output": "", "error": str(error), "exit_code": 1}

    return {"command": command, "output": outcome.output, "error": None, "exit_code": outcome.exit_code}
