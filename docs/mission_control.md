# Mission Control

Mission Control is the official web interface of StarCore.

It shows the current state of the Core and of the Satellites loaded into it, and lets a user run commands and stop the Core from the browser. It talks to the Engine only through the public API, so it has no direct access to Core internals and no knowledge of individual Satellites.

## Starting StarCore

From the `engine` directory:

```
python -m starcore
```

The Engine loads its configuration, discovers Satellites and their commands, starts Mission Control and drops into the interactive terminal CLI - both run against the same Core at once, so a command typed in the terminal and a command run from Mission Control's Console see the same state. StarCore stays usable when Mission Control is disabled or cannot bind its port; only the web interface is unavailable in that case.

Mission Control is then available at:

```
http://127.0.0.1:8080
```

## What it displays

Mission Control is organized into tabs:

- **Overview** - the engine name, whether the Core is running, uptime, the number of loaded Satellites (split by type), the number of registered commands, and the address Mission Control is served from
- **Satellites** - a card for every loaded Satellite: name, version, author, description, type, enabled state, the CLI commands it contributes and the state it publishes
- **Console** - a web equivalent of the terminal CLI: it lists the available commands, lets a user enter and run one, and shows its output. It executes commands through the same command registry as the terminal, so behavior is identical either way.

The Overview and Satellites tabs poll the API every 5 seconds. If the Core becomes unreachable they keep the last known values and show an error message.

## Stopping StarCore

The topbar's "Stop StarCore" button requests a graceful shutdown of the Core through the API - the same shutdown a terminal CLI `exit` triggers. It asks for confirmation before sending the request, and once StarCore has stopped the page stops polling and disables the Console.

## Configuration

Mission Control uses the `[server]` section of `engine/config.toml`:

```toml
[server]
enabled = true
host = "127.0.0.1"
port = 8080
```

`enabled = false` starts the Core without the web interface. Defaults are used when the section, a key or the configuration file itself is missing.

## Satellites in Mission Control

Satellites are never hardcoded into the Core or into the frontend. A Satellite appears in Mission Control as soon as the Engine discovers it, and it can publish its own state through the `state.py` convention described in the Satellites documentation. Mission Control renders whatever a Satellite publishes as generic labelled values.

## API

Mission Control is a client of the Engine API, which is described in the API documentation. The frontend itself is plain HTML, CSS and JavaScript served by the Engine from the `mission_control` directory, so it has no build step and no dependencies.

The Console does not implement its own command handling - it calls `POST /api/commands/execute`, which runs the command through `StarCore.execute_command()`, the same method the terminal CLI calls directly.
