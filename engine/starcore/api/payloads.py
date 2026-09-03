from contextlib import redirect_stdout
import io


def describe_satellite(engine, satellite) -> dict:
    return {
        "name": satellite.manifest.name,
        "version": satellite.manifest.version,
        "author": satellite.manifest.author,
        "description": satellite.manifest.description,
        "type": satellite.type,
        "enabled": bool(satellite.config.get("enabled", True)),
        "commands": describe_commands(engine, source=satellite.manifest.name),
        "state": satellite.state(engine),
        "page": satellite.page,
    }


def describe_satellites(engine) -> list:
    return [describe_satellite(engine, satellite) for satellite in engine.registry.all()]


def describe_commands(engine, source=None) -> list:
    commands = []

    for name, entry in engine.command_registry.all().items():
        if source is not None and entry["source"] != source:
            continue

        metadata = entry["metadata"]
        commands.append({
            "name": name,
            "source": entry["source"],
            "description": metadata.get("description", ""),
            "usage": metadata.get("usage", ""),
            "category": metadata.get("category", ""),
            "aliases": metadata.get("aliases", []),
        })

    return commands


def execute(engine, command: str) -> dict:
    # captures stdout the same way the terminal CLI's own loop does
    # (`if result is not None: print(result)`), so the console shows exactly
    # what a terminal would have shown for the same command
    buffer = io.StringIO()

    try:
        with redirect_stdout(buffer):
            result = engine.execute_command(command)
            if result is not None:
                print(result)
    except Exception as error:
        return {"command": command, "output": buffer.getvalue(), "error": str(error)}

    return {"command": command, "output": buffer.getvalue(), "error": None}
