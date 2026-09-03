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

A persistent sidebar divides Mission Control into the Core and the Satellites orbiting it.

The Core section holds the pages that belong to StarCore itself:

- **Overview** - whether the Core is running, uptime, the number of loaded Satellites (split by type), the number of registered commands, the engine name and the address Mission Control is served from, alongside a map of the Satellites in orbit around the Core
- **Satellites** - a card for every loaded Satellite: name, version, author, description, type, enabled state and the CLI commands it contributes
- **Console** - a web equivalent of the terminal CLI: it lists the available commands, lets a user enter and run one, and shows its output. It executes commands through the same command registry as the terminal, so behavior is identical either way.
- **Configuration** - view the current `[server]` settings and change them, with the same validation and "restart required" honesty as the CLI's `config` command. See "Configuration" below.

The Satellite section below it is built from the API rather than from a fixed list. A Satellite earns its own page by shipping one (`mission_control/page.js`, as the Photo Satellite does) or by publishing state through the `state.py` convention, in which case Mission Control renders that state generically. A Satellite that does neither stays in the Satellites list without a page of its own. The section scrolls on its own, so the Core pages stay reachable however many Satellites are loaded.

Pages are addressable: `#/overview`, `#/satellites`, `#/console`, `#/configuration` and `#/satellite/<name>` can be linked to directly, and browser navigation works as expected.

Mission Control polls the API every 5 seconds. If the Core becomes unreachable it keeps the last known values and shows an error message.

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

`host`, `port` and `enabled` can all be viewed and changed from the Configuration page, without editing `config.toml` by hand - the same is true from the terminal CLI's `config` command (`docs/cli.md` covers the command convention it follows) and from `GET`/`POST /api/configuration` directly. All three go through the same `Configuration.set()` call, so validation and persistence are identical everywhere: an invalid value (an empty host, a non-numeric or out-of-range port) is rejected with a clear error and nothing is written.

`[server]` is only read once, when the Core starts, so a saved change never applies to the process that's already running - the Configuration page, the CLI and the API all say so plainly ("restart required") rather than implying the change is live. Restart StarCore for a saved `[server]` change to take effect.

By default `host = "127.0.0.1"` keeps Mission Control reachable only from the machine it runs on. Setting `host = "0.0.0.0"` makes it reachable from other devices on the same private network - see "Private LAN access" in the deployment documentation for how to do that safely, including the firewall changes it typically requires. Mission Control has no authentication yet, so a LAN-reachable instance is trusted the way any other unauthenticated device on that network would be; it should never be exposed to the public internet.

## Satellites in Mission Control

Satellites are never hardcoded into the Core or into the frontend. A Satellite appears in Mission Control as soon as the Engine discovers it, and it decides for itself what it contributes: state, routes of its own, a page of its own, or nothing at all. Mission Control renders published state as generic labelled values, and hands a Satellite that ships a page the container to draw in. Both are described in the Satellites documentation.

## API

Mission Control is a client of the Engine API, which is described in the API documentation. The frontend itself is plain HTML, CSS and JavaScript served by the Engine from the `mission_control` directory, so it has no build step and no dependencies.

The Console does not implement its own command handling - it calls `POST /api/commands/execute`, which runs the command through `StarCore.execute_command()`, the same method the terminal CLI calls directly.
