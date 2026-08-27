CLI command convention

Command name = Python module = Entry function

Example:

version
    -> commands/version.py
    -> def version()

discover
    -> commands/discover.py
    -> def discover()

Core commands live in `engine/starcore/cli/commands/`.

## Satellite commands

Satellites can contribute their own CLI commands using the same convention,
scoped to a `commands/` directory inside the satellite itself:

status (status satellite)
    -> satellites/native/status/commands/status.py
    -> def status()

Satellite commands are discovered automatically whenever their satellite is
discovered, and are registered into the same command registry as core
commands, so they're invoked the same way (e.g. `status`, with any
arguments handled by the command itself).

A command name must be unique across the whole registry. Core commands are
discovered first, so they always take priority: a satellite cannot shadow a
core command or another satellite's command with the same name. A satellite
that doesn't have a `commands/` directory simply contributes no commands.