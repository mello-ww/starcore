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

The Engine currently serves an HTTP API. It is started with the Core and configured through the `[server]` section of `engine/config.toml`. Everything is read-only except the three control endpoints below.

```
GET  /api/status                  current Core status
GET  /api/satellites              every loaded Satellite
GET  /api/satellites/<name>       a single Satellite, matched case-insensitively
GET  /api/commands                every registered CLI command and its metadata
GET  /api/configuration           the configurable settings and their current value
POST /api/commands/execute        run a registered command
POST /api/configuration           change one configuration setting
POST /api/shutdown                gracefully stop the Core
POST /api/restart                 gracefully stop the Core, then restart the process
GET  /api/auth/status             whether an administrator account exists and this client is signed in
POST /api/auth/setup              create the first (and only) administrator account
POST /api/auth/login              start a session
POST /api/auth/logout             end the current session
GET  /api/auth/sessions           every active session (labeled web/mobile), for the "Active sessions" panel
POST /api/auth/sessions/revoke    end one specific session by id, from anywhere
```

Every endpoint above other than `/api/auth/status`, `/api/auth/setup`, `/api/auth/login` and
`/api/auth/logout` requires a session once an administrator account has been created - see
"Authentication" below. Note that this now includes `/api/auth/sessions` and
`/api/auth/sessions/revoke` themselves: listing or revoking sessions is exactly the kind of
thing that must not be reachable by an unauthenticated caller, so those two do not get the
same free pass as the other four `/api/auth/*` endpoints.

Responses are JSON. A Satellite entry contains its manifest information, its type, whether it is enabled, the commands it contributes and the state it publishes:

```json
{
  "name": "Status",
  "version": "1.0.0",
  "author": "mellow",
  "description": "System monitoring satellite.",
  "icon": "icon.svg",
  "type": "native",
  "enabled": true,
  "status": "running",
  "commands": [{ "name": "status", "source": "Status", "description": "..." }],
  "state": { "refresh_rate": 1 },
  "configurable": false,
  "mobile_ui": false
}
```

`status` is one of `"running"`, `"stopped"`, `"disabled"` or `"error"` - computed entirely
generically (see `_satellite_status()` in `starcore/api/payloads.py`), never by branching on
a Satellite's name. `"error"` means the Satellite's last `start`/`stop` hook failed;
`"stopped"` means it declares a background service (see "Running a background service" in
`docs/satellites.md`) that isn't currently running, whether because it's between starts or
because `[satellites].services` is off entirely; a Satellite with no background service at
all is simply `"running"` whenever it's enabled, since there's nothing to actually be
stopped. `icon` is the filename of an icon the Satellite declared in its own `satellite.toml`
(served through the same `assets` route below), or `null` if it didn't - Mission Control
falls back to a generic icon in that case.

`configurable` is `true` when the Satellite has named one of its own routes
`"configuration"` - it is the entire signal Mission Control uses to decide whether to show
that Satellite a Config button, and the only thing the Core itself knows about a Satellite's
settings. See "Exposing configuration" in the Satellites documentation.

`mobile_ui` is the same convention for a route named `"mobile"` instead: `true` when the
Satellite offers a declarative screen for StarCore's mobile app, which is the one thing the
mobile app's Satellites screen uses to decide whether opening that Satellite shows a real
screen or just its name and status. See "Exposing a mobile interface" in the Satellites
documentation for the declarative UI schema itself (`GET /api/satellites/<name>/mobile`) -
it is a Satellite endpoint like any other, not a second API.

`POST /api/commands/execute` takes `{"command": "<name> [args...]"}` and runs it through `StarCore.execute_command()` - the same call the terminal CLI makes - so behavior and output match the terminal exactly. It responds with the captured output and, if the command raised, an error:

```json
{ "command": "status", "output": "...", "error": null }
```

An unknown command is not treated as a server error: it comes back as a normal `200` with the registry's own "not found" message in `output`. Only an exception escaping the command itself produces `error` and a `500`. The response also carries the command's `exit_code` (see the CLI documentation). The console runs as a remote caller: read-only commands and those explicitly marked remote (Music playback, likes and playlist edits) run; anything else that changes state - scans, imports, configuration, lifecycle - is refused with exit code 3 and must be run from StarCore's terminal or the one-shot CLI.

`GET /api/commands` lists every command; a typed namespace also carries `commands`, the schema of each subcommand a remote console may run.

`POST /api/cli/run` is the one-shot CLI's own channel to a running StarCore. It accepts only the per-run token from `control.json` in the data directory (header `X-StarCore-Control`) and only from this machine - never a session - and answers `403` otherwise. See "How the one-shot CLI reaches the running StarCore" in the CLI documentation.

`POST /api/shutdown` requests a graceful shutdown of the Core - the same shutdown the terminal CLI's `exit` triggers - and stops Mission Control as part of it. It responds immediately with `{"message": "..."}`; the Core stops shortly after.

`POST /api/restart` stops the Core the same way `/api/shutdown` does - it is not a second
shutdown implementation - but leaves `StarCore.restart_requested` set, so the process
entrypoint (`starcore.cli.main.main()`) re-execs itself (`os.execv`) once `stop()` returns,
instead of exiting for good. Every service is fully torn down and a fresh interpreter starts
StarCore from scratch, so nothing can be left half-initialized; this is a real restart, not a
Mission-Control-only refresh. It responds immediately with `{"message": "..."}`. Mission
Control's own Restart button polls `/api/status` afterwards and reconnects automatically once
the new process answers.

`GET /api/configuration` lists the settings that can be changed through the API, the CLI's `config` command and Mission Control's Configuration page - currently just `[server]`. Each entry carries its saved value from `config.toml` and whether it differs from what's actually running, since `[server]` is only read once, at startup:

```json
{
  "settings": [
    { "section": "server", "key": "host", "path": "server.host", "value": "127.0.0.1",
      "description": "Mission Control bind address", "restart_required": true,
      "live_value": "127.0.0.1", "pending_restart": false }
  ],
  "restart_required": false
}
```

`POST /api/configuration` takes `{"section": "...", "key": "...", "value": ...}`, validates and saves one setting through `Configuration.set()`, and responds with the same shape as the `GET`. An unknown `section.key` or a value that fails validation (an empty host, a non-numeric or out-of-range port, ...) is rejected with a `400` and nothing is written.

## Satellite endpoints

A Satellite can serve routes and Mission Control assets of its own, mounted below its name:

```
GET|POST /api/satellites/<name>/<route>/...   a route the Satellite provides
GET      /api/satellites/<name>/assets/...    the Satellite's Mission Control files
```

`assets`, `enable`, `disable` and `reload` are reserved by the Core and never reach a
Satellite's own `api.py` - `assets` is served read-only from the Satellite's
`mission_control/` directory, and the other three are the generic lifecycle controls below.
Everything else below a Satellite comes from the mapping its `api.py` returns, and the Core
neither knows nor cares what those routes do. Only GET and POST reach them. The Satellites
documentation describes the handler contract, and the Photo and Music documentation are
worked examples. The Status Satellite's read-only monitoring routes (`metrics`, `history`,
`diagnostics`) are described in `docs/satellites/status.md`.

```
POST /api/satellites/<name>/enable    starts the Satellite and marks it enabled
POST /api/satellites/<name>/disable   stops the Satellite and marks it disabled
POST /api/satellites/<name>/reload    rebuilds the Satellite from disk and restarts it if enabled
```

These work identically for every Satellite, native or link - they are handled entirely by
the Core (`StarCore.set_satellite_enabled()` / `.reload_satellite()`), never by a Satellite's
own code, and are what Mission Control's Satellites page uses for its enable/disable and
reload controls. Each responds with the same shape:

```json
{ "satellite": { "...": "the same object GET /api/satellites/<name> returns" },
  "error": null }
```

`error` is `null` on success. It is a message, and the response status is `500`, when the
Satellite's own `start`/`stop` hook (see "Running a background service" in
`docs/satellites.md`) raised - the same way `/api/commands/execute` reports a command that
raised. Crucially, a failed `enable`/`disable` never leaves the Satellite looking like it
changed state: the config is only persisted once the hook actually reports success, so
`satellite.enabled` in the response always reflects what actually happened, not what was
requested. A `reload` whose Satellite failed to stop first, or whose manifest can no longer
be read, is left registered exactly as it was rather than replaced with something broken.
An unknown Satellite name is a `404`, and any method other than `POST` is rejected the same
way every other write endpoint is.

`configuration` is not reserved the way `assets` is - the Core does not implement it - but
it is the one route name Mission Control treats specially, purely by name (see
`configurable` above): a Satellite that wants a Config button in Mission Control names one
of its own routes `configuration` and answers `GET`/`POST` on it following the convention in
`docs/satellites.md`. Photo's `GET|POST /api/satellites/photo/configuration` (`docs/satellites/photo.md`)
is the first Satellite to do this.

A file a Satellite returns is streamed rather than read into memory, and a `Range` request
is answered with `206` and just the bytes asked for, so a browser can seek in a large file
without downloading all of it. A Satellite route can also ask for the response to download
as an attachment (`file_response(path, content_type, download_name="report.pdf")`) - the File
Explorer Satellite (`docs/api.md` below, `satellites/native/file_explorer/`) is the first to
use this; nothing else has needed to yet.

A `POST` to a Satellite route is parsed as JSON the same way it always has been, *unless* the
request's `Content-Type` isn't `application/json` - in which case `request.body` is `None`
and `request.raw` is a `RawBody` the handler reads in chunks (`request.raw.read(size)`),
never buffered whole into memory. This is what lets a Satellite accept a file upload as a
raw request body (see File Explorer's `upload` route) without a second, JSON-only dispatch
path or a second body-parsing implementation.

Errors are returned as `{"error": "..."}` with an HTTP status: `400` for a malformed request body, `404` for an unknown endpoint or Satellite, `405` for a method a given endpoint doesn't support. The API exposes no way to run arbitrary code or shell commands - only registered commands can be executed.

The same server also serves the Mission Control frontend from the `mission_control` directory.

## Authentication

StarCore ships with a single-administrator authentication system (`starcore/auth.py`) -
deliberately not a multi-user account system; see "Authentication architecture" below for
why. Until an administrator account exists, the API is intentionally open (see
`ApiServer._authorized()` docstring in `starcore/api/server.py`) so that `/api/auth/setup`
itself - and Mission Control's setup screen - are reachable with no session at all. This is
exactly why the default bind address is `127.0.0.1`: exposing a freshly-installed,
not-yet-configured StarCore beyond localhost is a decision for whoever deploys it to make
deliberately, not something the API alone makes safe.

Once an administrator account exists (`GET /api/auth/status` reports `"bootstrapped": true`),
every endpoint above other than the four always-open auth endpoints (`AUTH_OPEN_ENDPOINTS` in
`starcore/api/server.py`) requires a valid session, checked by one generic gate before any
dispatch happens - there is no per-endpoint special-casing, and this is also why File
Explorer, Photo, Music, Locked Folder and Console shutdown/restart are all protected for free
the moment they're reachable under `/api/`.

```
POST /api/auth/setup   { "username": "...", "password": "..." }  -> 200 + session, or 409 if already set up
POST /api/auth/login    { "username": "...", "password": "...",
                          "kind": "web"|"mobile", "device_name": "..." } -> 200 + session, 401, or 429
POST /api/auth/logout   (no body)                                -> 200, ends the current session
GET  /api/auth/status   (no body)                                -> { "bootstrapped": bool, "authenticated": bool,
                                                                     "username": "..." (only when authenticated) }
```

After 5 failed logins in a row from one client address, `login` answers
`429 {"error": "...", "retry_after": <seconds>}` with a matching `Retry-After` header for 30
seconds, doubling on each further lockout up to 15 minutes; a successful login resets it.
This applies even to the right password while locked out. The record is kept in memory per
address, so behind a reverse proxy every client shares one lockout.

JSON request bodies have a size limit, checked against `Content-Length` before anything is
read: 64 KB for the four auth endpoints above, 16 MB for every other endpoint. A larger body
gets `413`, and an invalid `Content-Length` gets `400`. Non-JSON uploads are streamed and not
subject to this limit.

A successful setup or login sets a `starcore_session` cookie (`HttpOnly`, `SameSite=Lax`,
and `Secure` automatically when HTTPS is enabled - see below). A client that isn't a browser
(a future mobile app, a script) can use the same token as a bearer token instead:
`Authorization: Bearer <token>` - both are checked by the same `AuthStore.validate_session()`,
so nothing about session handling assumes a browser.

`login`'s `kind` and `device_name` are optional labels, not a second authentication mechanism:
a future mobile client logs in through this exact endpoint like any other client, just passing
`"kind": "mobile"` and a human-readable `device_name` (e.g. `"Nathan's iPhone"`) so the session
can be told apart later. Omitted, both default to a plain `"web"` session with no device name,
so every existing caller is unaffected. See "Locked Folder and mobile authentication" in
`docs/satellites/locked_folder.md` for the full design.

`POST /api/auth/login` with `"kind": "mobile"` also returns the issued token in the JSON body
(`{"message": "Logged in.", "token": "..."}`), in addition to the same `Set-Cookie` a web login
gets. This is the one deliberate difference between the two: a browser's `fetch()` can't read
`Set-Cookie` from script anyway (nor would it need to - the cookie jar handles it), but a native
mobile HTTP stack (OkHttp on Android, NSURLSession on iOS) does not expose that header to
application code either, and has no cookie jar of its own to fall back on - so without this,
`mobile/` would have no way to learn the token it was just issued. A plain (`"kind": "web"` or
omitted) login's body is completely unchanged - no `token` key at all - so this is additive and
opt-in, never a change to the browser flow. See `mobile/src/api/auth.ts` and
`test_a_mobile_login_also_returns_the_token_in_the_response_body` / `test_a_web_login_does_not_return_a_token_in_the_body`
in `test_auth.py`.

```
GET  /api/auth/sessions          (no body) -> { "sessions": [ { "session_id", "kind",
                                                 "device_name", "created", "expires",
                                                 "current" }, ... ] }
POST /api/auth/sessions/revoke   { "session_id": "..." } -> { "revoked": "<session_id>" },
                                                             or 404 if unknown
```

`GET /api/auth/sessions` lists every still-valid session for the single administrator
account - never the raw session token itself, only the opaque `session_id` used to revoke it -
sorted newest first, with `current` marking the session the caller is making the request with.
This is what lets the Mission Control "Active sessions" panel (and, later, a mobile app's own
"manage devices" screen) show and end sessions, including ones started from a different
device. Revoking the caller's own current session ends it immediately, exactly like
`/api/auth/logout`.

Passwords are hashed with `hashlib.pbkdf2_hmac` (260,000 iterations, a random 16-byte salt
per account) via the shared `hash_secret()` helper in `starcore/auth.py` - never stored,
logged, or returned anywhere. The Locked Folder Satellite's PIN (see `docs/satellites/locked_folder.md`)
reuses this exact same function rather than a second hashing implementation. Sessions expire
after 7 days. Nothing about the credential store depends on a third-party package; see
"Dependencies" in `docs/deployment.md`.

Every satellite route handler also receives the caller's already-validated session token as
`request.token` (see `Request` in `starcore/api/response.py`) - set by `_authorized()` once,
threaded through `_handle_satellite()`, and empty only when the API is still in its
pre-bootstrap open state. This is what lets a Satellite implement its own, session-aware
authorization on top of the Core's session check without re-validating anything itself or
touching `starcore/auth.py` - the Locked Folder Satellite (`docs/satellites/locked_folder.md`) is the
first and so far only Satellite that needs this.

Photo Sync (`satellites/native/photo/sync.py`) is a separate, deliberately unauthenticated
HTTP listener on its own port, protected by its own device token instead - it is not part of
Mission Control's API server and this authentication system does not apply to it. See
"Photo Sync and authentication" in `docs/satellites/photo.md` for why that separation stays as it is.

## HTTPS

Configured through the same `[server]` section as everything else in `engine/config.toml`:

```toml
[server]
https_enabled = false
https_cert = ""   # path to a PEM certificate file
https_key = ""    # path to a PEM private key file
```

When `https_enabled` is true, `ApiServer.start()` wraps its listening socket in TLS using the
stdlib `ssl` module - no dependency. If the certificate or key is missing, unreadable, or
doesn't match, Mission Control does **not** start and a `[WARNING]` explains why - it never
silently falls back to plain HTTP, since that would be a false sense of security. See
"HTTPS" in `docs/deployment.md` for how to obtain a certificate (including a self-signed one
for local/LAN use) on both Windows and Linux.

This document will evolve as the API grows.