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