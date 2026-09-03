from ...engine_config import ConfigurationError, describe

COMMAND = {
    "description": "Inspect or change StarCore's server configuration.",
    "usage": "config [<section.key> <value>]",
    "aliases": [],
    "category": "Core",
    "examples": [
        "config",
        "config server.host 0.0.0.0",
        "config server.port 8090",
    ],
}


def config(engine, args):
    if not args:
        _show(engine)
        return

    if len(args) != 2:
        print(f"[ERROR]: Usage: {COMMAND['usage']}")
        return

    path, raw_value = args
    section, dot, key = path.partition(".")
    if not dot:
        print(f"[ERROR]: '{path}' is not a valid setting - use the form section.key, e.g. server.host")
        return

    try:
        value = engine.config.set(section, key, raw_value)
    except ConfigurationError as error:
        print(f"[ERROR]: {error}")
        return

    print(f"{path} = {value}")
    print("Saved to config.toml. Restart StarCore for this to take effect.")


def _show(engine):
    settings = describe(engine.config)
    if not settings:
        print("No configurable settings are registered.")
        return

    print("StarCore configuration\n")
    width = max(len(setting["path"]) for setting in settings)
    for setting in settings:
        print(f"{setting['path']:<{width}}  {setting['value']!r:<10}  {setting['description']}")

    print(f"\nChange a setting:  {COMMAND['usage']}")
    print("Changes are saved to config.toml immediately but need a restart to take effect.")
