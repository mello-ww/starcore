# API

The Engine exposes a public API used by every official client.

This includes:

- Mission Control
- CLI
- SDKs
- Third-party applications
- Satellites

The API consists of REST endpoints and a WebSocket interface.

## Implemented endpoints

The Engine currently serves an HTTP API. It is started with the Core and configured through the `[server]` section of `engine/config.toml`. Everything is read-only except the two control endpoints below.

```
GET  /api/status                  current Core status
GET  /api/satellites              every loaded Satellite
GET  /api/satellites/<name>       a single Satellite, matched case-insensitively
GET  /api/commands                every registered CLI command and its metadata
POST /api/commands/execute        run a registered command
POST /api/shutdown                gracefully stop the Core
```

Responses are JSON. A Satellite entry contains its manifest information, its type, whether it is enabled, the commands it contributes and the state it publishes:

```json
{
  "name": "Status",
  "version": "1.0.0",
  "author": "mellow",
  "description": "System monitoring satellite.",
  "type": "native",
  "enabled": true,
  "commands": [{ "name": "status", "source": "Status", "description": "..." }],
  "state": { "refresh_rate": 1 }
}
```

`POST /api/commands/execute` takes `{"command": "<name> [args...]"}` and runs it through `StarCore.execute_command()` - the same call the terminal CLI makes - so behavior and output match the terminal exactly. It responds with the captured output and, if the command raised, an error:

```json
{ "command": "status", "output": "...", "error": null }
```

An unknown command is not treated as a server error: it comes back as a normal `200` with the registry's own "not found" message in `output`. Only an exception escaping the command itself produces `error` and a `500`.

`POST /api/shutdown` requests a graceful shutdown of the Core - the same shutdown the terminal CLI's `exit` triggers - and stops Mission Control as part of it. It responds immediately with `{"message": "..."}`; the Core stops shortly after.

## Satellite endpoints

A Satellite can serve routes and Mission Control assets of its own, mounted below its name:

```
GET|POST /api/satellites/<name>/<route>/...   a route the Satellite provides
GET      /api/satellites/<name>/assets/...    the Satellite's Mission Control files
```

`assets` is reserved by the Core and served read-only from the Satellite's
`mission_control/` directory; everything else below a Satellite comes from the mapping its
`api.py` returns, and the Core neither knows nor cares what those routes do. Only GET and
POST reach them. The Satellites documentation describes the handler contract, and the Photo
and Music documentation are worked examples.

A file a Satellite returns is streamed rather than read into memory, and a `Range` request
is answered with `206` and just the bytes asked for, so a browser can seek in a large file
without downloading all of it.

Errors are returned as `{"error": "..."}` with an HTTP status: `400` for a malformed request body, `404` for an unknown endpoint or Satellite, `405` for a method a given endpoint doesn't support. The API exposes no way to run arbitrary code or shell commands - only registered commands can be executed.

The same server also serves the Mission Control frontend from the `mission_control` directory.

This document will evolve as the API grows.