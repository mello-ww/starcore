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

## Satellites with several modules

A Satellite directory is importable as a package, so a Satellite that outgrows a single
file can split itself up and use relative imports (`from .library import ...`) from its
`state.py`, `api.py` and its commands.

## Types of Satellites

### Native Satellites

Native Satellites provide functionality directly within StarCore.

Examples include:

- Status
- Files
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