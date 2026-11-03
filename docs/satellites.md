# Satellites

Satellites are installable modules that extend StarCore without modifying the Engine.

They are discovered, loaded and managed by the Engine through a common extension system.

A Satellite can:

- expose API endpoints
- emit Signals
- store data
- contribute pages to Mission Control
- provide CLI commands (see CLI)
- publish state to Mission Control

## Publishing state

A Satellite can publish state to Mission Control by adding a `state.py` module to its
directory, following the same convention as commands (module name = entry function name):

```
satellites/native/status/state.py
    -> def state(engine, satellite) -> dict
```

The Engine calls it whenever the API is asked for Satellites, and returns the dictionary
as-is. Keys are free: Mission Control renders them generically, so a Satellite decides
what it publishes without any change to the Core or to the web interface. A Satellite
without a `state.py` simply publishes nothing.

The function receives the Engine and its own Satellite, which gives it access to Core
state and to its own manifest and configuration. A provider that fails or returns
something other than a dictionary is reported as a warning and treated as empty state,
so one Satellite cannot break the dashboard.

## Serving data and files

A Satellite can answer requests of its own by adding an `api.py` module that returns a
mapping of route names to handlers:

```
satellites/native/photo/api.py
    -> def routes() -> {"library": handler, ...}
```

Every route is mounted below the Satellite, so `"library"` is served at
`/api/satellites/photo/library`, and anything after the route name reaches the handler as
path segments. A handler receives a `Request` (the Engine, its own Satellite, the method,
the remaining path, the query and a parsed JSON body) and returns a `Response`, both from
`starcore.api.response`:

```python
from starcore.api.response import error_response, file_response, json_response
```

GET and POST reach Satellite routes; other methods are refused by the Core. A handler that
raises is reported as a warning and answered with a generic error, so a Satellite cannot
take Mission Control down or leak a trace to the browser. A Satellite that serves files is
responsible for making sure the paths it returns belong to its own storage - the Core
serves what it is given.

## Running a background service

A Satellite that needs something running for as long as StarCore does declares it in
`satellite.py`:

```
satellites/native/photo/satellite.py
    -> def start(engine, satellite)
    -> def stop(engine, satellite)
```

The Core calls `start` for every enabled Satellite once discovery is finished, and `stop`
when it shuts down. Both are optional, and a hook that raises is reported as a warning and
otherwise ignored, so a Satellite that fails to start cannot stop the Core from running. The
Photo Satellite uses this to run its phone-sync listener.

Setting `services = false` under `[satellites]` in `engine/config.toml` starts the Core
without any Satellite service, which is what the test suite does so a run never binds a port
or writes into a Satellite's real storage.

## Status and icon

`describe_satellite()` (`starcore/api/payloads.py`) reports a generic `status` for every
Satellite - `"running"`, `"stopped"`, `"disabled"` or `"error"` - computed entirely from
things the Core already knows: whether the Satellite is enabled, whether it declares a
background service at all (`Satellite.has_service`, `True` whenever `satellite.py` defines
`start` or `stop`), whether `[satellites].services` is on, and the outcome of its last
`start`/`stop` hook (`Satellite.running` / `Satellite.last_error`, updated by `_run()` on
every hook call). None of this is per-Satellite branching - a Satellite with no `satellite.py`
at all is simply `"running"` whenever it's enabled, since there's nothing that could be
stopped out from under it.

A Satellite can also declare an icon in its `satellite.toml`:

```toml
icon = "icon.svg"
```

naming a file under its own `mission_control/` directory. It's validated at load time - a
declared file that doesn't exist is dropped with a warning rather than failing the whole
Satellite - and served through the same `GET /api/satellites/<name>/assets/<icon>` route as
any other Mission Control asset (see "Contributing a Mission Control page" below), so nothing
new is needed to serve it. `describe_satellite()` reports it as `icon`, or `null` if the
Satellite didn't declare one; Mission Control falls back to a generic icon in that case. The
Core holds no name-to-icon mapping of its own - a Satellite that wants a recognizable mark in
the sidebar and on its card provides its own image, the same way it provides its own page.

A Satellite whose interface lives inside another Satellite's page can say so:

```toml
section_of = "Photo"
```

`describe_satellite()` reports it as `section_of` (`null` otherwise). Mission Control then
gives it no sidebar entry or Home card, and opens `#/satellite/<it>` as
`#/satellite/<host>/<it>`, handing the host page that section name in its mount context
(`context.section`) and through `cleanup.showSection(section)` while it's showing. The
Android app leaves it out of the Satellites list. It is presentation only: the Satellite
keeps its own routes, data and configuration, and they are exactly as protected as any
other's. The Locked Folder uses this to appear as a tab of Photos.

## Enabling, disabling and reloading

Every Satellite - native or link, with or without a background service - can be enabled,
disabled and reloaded from Mission Control's Satellites page, or directly through
`POST /api/satellites/<name>/enable|disable|reload` (see `docs/api.md`). This is generic: it
is implemented once, entirely in the Core (`StarCore.set_satellite_enabled()` and
`.reload_satellite()`), and works the same way for every Satellite without any of them having
to do anything beyond the `start`/`stop` hooks described above.

Disabling calls `stop`, then persists `enabled = false` to the Satellite's `config.toml` -
but only once `stop` actually succeeds, so a Satellite whose service fails to stop is not
falsely reported as disabled. Enabling does the same in reverse with `start`. Reloading calls
`stop` (if the Satellite is currently enabled), rebuilds the Satellite from disk exactly the
way discovery does - a fresh read of its manifest and config, and a fresh import of its
`state.py`, `api.py` and `satellite.py` - and, if it's still enabled, calls `start` again. A
Satellite whose manifest can no longer be read, or that fails to stop before a reload, is
left registered and running exactly as it was rather than replaced or left half-restarted.

None of this reaches into what a Satellite's `start`/`stop` actually do, or restarts the Core
or any other Satellite - reloading Photo does not touch Music, and does not require Mission
Control itself to restart. A Satellite's routes, commands and Mission Control page are all
rebuilt as part of a reload; only its already-imported submodules (anything a `state.py` or
`api.py` reaches with `from .library import ...`) keep the code they had at the last
successful (re)load, the same way any other Python import caching works.

## Contributing a Mission Control page

A Satellite that ships `mission_control/page.js` gets its own page in Mission Control,
listed in the sidebar under SATELLITES. The file is an ES module exporting `mount`:

```javascript
export function mount(context) { ...; return () => cleanup(); }
```

`context` carries the container element to render into, the Satellite's own payload, and an
`api` helper bound to the Satellite's routes (`get`, `post` and `url`). The returned
function, if any, is called when the user navigates away. An optional
`mission_control/page.css` next to it is loaded with the page, and everything under
`mission_control/` is served read-only from `/api/satellites/<name>/assets/`.

A Satellite without a page still gets one: Mission Control renders whatever it publishes
through `state.py` as generic labelled values. A Satellite that provides neither is listed
on the Satellites page but has no page of its own.

## Exposing configuration

A Satellite that wants its own settings editable from Mission Control simply names one of
its `api.py` routes `"configuration"`:

```
satellites/native/photo/api.py
    -> def routes() -> {..., "configuration": handler, ...}
```

That name is the entire contract with the Core. `describe_satellite()` reports
`"configurable": true` for any Satellite with a `"configuration"` route, Mission Control
shows a gear button on its card (and, on the Satellite's own page, in the topbar) whenever
that flag is set, and the button opens a generic modal that renders whatever fields the
route's GET response describes. The Core never sees a Satellite's setting names or their
meaning - a Satellite that doesn't name a `"configuration"` route simply has no gear button,
the same way a Satellite without `mission_control/page.js` simply has no page.

The Core does not prescribe a request or response shape beyond what a Satellite route
already follows (GET and POST, `Request` in, `Response` out - see "Serving data and
files"), but the convention every native Satellite follows, and that Mission Control's
generic modal is built against, is:

```
GET  /api/satellites/<name>/configuration
    -> {"settings": [{"key", "value", "description", "live_value", "pending_restart"}, ...],
        "restart_required": bool, "note": string|null}

POST /api/satellites/<name>/configuration  {"key": ..., "value": ...}
    -> the same shape, after validating, persisting and applying one setting
```

A setting descriptor may also carry an optional `"type"`. The only value defined so far is
`"path"`, meaning the setting is a filesystem directory (Photo's `photo_directory` and
Music's `library` both use it - see `docs/satellites/photo.md`); Mission Control's generic modal reacts
to it by adding a "Browse…" button next to the field, backed by the FileExplorer
Satellite's own `entries` route, so a directory can be picked instead of typed. This is the
one, narrow exception to Mission Control never hardcoding a Satellite's name into its
generic code: it delegates to whichever Satellite is named `"FileExplorer"` (if any is
present and enabled) because that Satellite's entire purpose is generic filesystem
browsing, not because the picker branches on who asked. A Satellite with a `"path"`-typed
setting still works with no FileExplorer present or enabled - the field simply has no
Browse button, and typing a path directly still works.

A rejected value answers with the Core's usual `error_response` (HTTP 400, `{"error":
"..."}`), which Mission Control's modal renders as a validation error next to the field
instead of closing it - the same pattern `engine_config.py`'s own `Configuration.set()`
uses for the Core's `[server]` settings. `live_value` and `pending_restart` let a Satellite
say a setting was saved but the running service hasn't picked it up yet, for a value that
can't simply be re-read from a live listener; a Satellite whose service can just be
restarted (see "Running a background service") can instead apply the change immediately and
report it through `note` instead, the way Photo Sync does for `sync_host`/`sync_port`.

Everything else - which settings exist, their defaults, validation and where they persist -
belongs entirely to the Satellite. `starcore.satellite_config.SatelliteConfig` (a
Satellite's own `config.toml`, matching the loaded manifest) gained a generic `set(key,
value)` alongside its existing `get()`, so a Satellite can persist a change with a single
call; it writes the one key back to the file with the same comment-preserving, targeted edit
`engine_config.py` uses for `engine/config.toml`, and otherwise does no validation of its
own - that stays the Satellite's job, exactly as `Configuration.set()` leaves validation to
its caller for the Core's own settings.

A Satellite that ships a `config.default.toml` beside its `config.toml` gets its defaults kept
up to date automatically the same way the Core's own `[server]` settings do: discovery fills in
any key an installation's `config.toml` is missing from it, and never touches a key that's
already there - see `docs/deployment.md`, "Keeping configuration up to date".

## Exposing a mobile interface

A Satellite that wants a screen in StarCore's mobile app names one of its `api.py` routes
`"mobile"`, the same way `"configuration"` gets it a Config button in Mission Control:

```
satellites/native/status/api.py
    -> def routes() -> {..., "mobile": handler, ...}
```

That name is the entire contract with the Core, exactly like `"configuration"`.
`describe_satellite()` reports `"mobile_ui": true` for any Satellite with a `"mobile"` route -
the one thing the mobile app's Satellites screen uses to decide whether tapping a Satellite
opens a screen or simply shows it as not yet supported on mobile. The Core does not otherwise
know or care what a Satellite's mobile screen contains.

The mobile app never downloads or executes a Satellite's own code - unlike
`mission_control/page.js` (see "Contributing a Mission Control page" above), which is fine to
run inside a browser tab but not something a phone app should be asked to `eval`. Instead, a
Satellite's `"mobile"` route answers with a small, declarative description of what to show,
and the mobile app's own code decides how to render each piece:

```
GET /api/satellites/<name>/mobile
    -> {"screen": {"title": "...", "sections": [
          {"type": "card", "title": "...", "items": [
            {"type": "text", "value": "...", "style": "body"|"heading"|"caption"},
            {"type": "status", "label": "...", "value": "..."},
            {"type": "list", "items": [{"title": "...", "subtitle": "..."}]},
            {"type": "button", "label": "...",
             "action": {"route": "<route beneath this satellite, or an absolute /api/... path>",
                        "method": "GET"|"POST", "confirm": "optional confirmation text"}}
          ]}
        ]}}
```

This is deliberately the smallest set of primitives that covers a status-style screen like
Status's own (`satellites/native/status/api.py` - a worked example, reusing `state.py`'s data
rather than a second copy of it), not a general-purpose UI framework; a future block can add
more item types (an input, a chart, a toggle bound to a satellite's own state) the same way -
by teaching the mobile app's renderer one more `"type"`, never by changing this contract or the
Core. A `"type"` the mobile app doesn't recognize yet is simply skipped, so an older mobile
build never breaks against a newer Satellite. A `"button"`'s `action.route` is resolved the same
way any other Satellite route is - relative to `/api/satellites/<name>/`, or, if it starts with
`/`, as an absolute path for the rare case of pointing at a Core endpoint instead.

A Satellite with no `"mobile"` route simply isn't offered on the mobile app's Satellites screen
as anything more than a name and a status - the same graceful fallback a Satellite without
`mission_control/page.js` already gets on the desktop.

## Developer Mode

Developer Mode is one switch, the terminal icon at the top right of Mission Control and of the
Android app's tabs (also under Settings on Android). It decides whether advanced settings,
diagnostics and developer tools are **shown**. It is off by default and remembered per account
in each browser, and per server on each phone.

It is a visibility preference, **never a permission**. The server neither knows nor checks it:
every route keeps its own authentication and authorization, a signed-in caller can still read or
change a "developer" setting through the API, and nothing secret (tokens, keys, PINs) is ever
added to a response because it might be shown. Hide only what is advanced; never hide what a
user needs day to day, or security information (Locked Folder's lockout and problems stay visible).

A Satellite opts in without a toggle of its own, in whichever of these it uses:

- **Settings**: add `"developer": True` to a setting your `configuration` route describes. The
  generic configuration dialog, and any page or screen that renders the settings, shows it only
  in Developer Mode, with a line saying how many advanced settings are hidden.
- **Mission Control page**: put a `data-developer` attribute on any element (one rule in
  `mission_control/home.css` hides it), and `data-developer-hint` on a short note that should show
  only outside Developer Mode. For anything that must react in code, `mount()`'s context has
  `developer`: `developer.enabled` and `developer.subscribe(fn)` (returns an unsubscribe function),
  for example to leave a section that just disappeared - Status's Diagnostics tab does this.
- **Mobile interface**: add `"developer": true` to a section or an item of the `"mobile"` route's
  screen; the app leaves it out unless Developer Mode is on.

Applied so far:

| Where | Shown only in Developer Mode |
|---|---|
| Mission Control | the Console; Mission Control's address and port (Configuration keeps Active sessions); Satellite reload buttons; each Satellite card's version, author and commands |
| Android | the Console and Config tabs |
| Music | exclude, min_duration, missing_metadata, scan_interval, ffmpeg, transcode_workers, transcode_cache_mb; transcode format; the Missing files and Transcoding tiles |
| Photos | sync_host, sync_port, sync_default_path; phone sync's upload counters and log |
| Status | the Diagnostics tab; Platform and Python on the generic mobile screen |

File Explorer has nothing advanced on its page yet. Its `root`, the boundary every request is
confined to, is changed in its `config.toml` only, and stays that way: showing a setting is not a
reason to add a route that changes it. Docker Links, Wings and AI Satellites use the same three
hooks; nothing in the shell needs to change for them.

## Satellites with several modules

A Satellite directory is importable as a package, so a Satellite that outgrows a single
file can split itself up and use relative imports (`from .library import ...`) from its
`state.py`, `api.py` and its commands.

## Types of Satellites

### Native Satellites

Native Satellites provide functionality directly within StarCore.

Examples include:

- Status
- FileExplorer
- Photos
- Music

### Link Satellites

Link Satellites integrate third-party applications and services.

Examples include:

- Docker
- Jellyfin
- Home Assistant
- MQTT

Both categories share the same lifecycle and extension model. The only difference is their purpose.

## Worked examples

- **Status** (`satellites/native/status/`, `docs/satellites/status.md`) - a background service
  (its metric sampler) feeding one cached snapshot to its routes, its published state (the Home
  summary), its CLI namespace and a Mission Control page with charts; a bounded SQLite history
  in StarCore's data directory; platform readings behind one backend interface.
- **Photo** (`satellites/native/photo/`, `docs/satellites/photo.md`) - state, routes, a Mission Control
  page, a background service (its phone-sync listener) and Satellite configuration, all
  together.
- **FileExplorer** (`satellites/native/file_explorer/`) - a Satellite with routes and a
  Mission Control page but no background service (`has_service` is `False`, so its status is
  always `"running"` while enabled), and the first to use `file_response(...,
  download_name=...)` and a raw (non-JSON) request body - see "Satellite endpoints" in
  `docs/api.md`. It has no `"configuration"` route and no configured root: it browses
  anywhere this StarCore process can itself reach - the whole Linux filesystem from `/`, or
  every present drive on Windows (`satellites/native/file_explorer/paths.py`'s
  `list_roots()`) - and lets the operating system's own permissions decide what actually
  succeeds, the same as any other program running as the same user. `paths.resolve_path()`
  still rejects malformed input outright (relative paths, empty paths, embedded null bytes)
  and `api.py`'s `_stat()` turns every `OSError` the OS reports (missing, permission denied,
  not a directory, ...) into a clean, specific response instead of a crash or a bare 500 -
  and a real filesystem root or drive can never be renamed or deleted through it - but there
  is no sandboxed root to stay inside of, by design. It is also what Mission Control's
  generic "path"-typed configuration fields (see "Exposing configuration" above) delegate to
  for their directory picker, through this same `entries` route.