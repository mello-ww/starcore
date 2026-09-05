"""Published to Mission Control's dashboard (see docs/satellites.md,
"Publishing state"). Also doubles as the warm-up point for the runtime
File Explorer's guard reaches into: engine.registry.get("LockedFolder")
alone only returns the Satellite object, not a populated
`.locked_folder_runtime` attribute - that only exists once runtime() has
run at least once (see runtime.py). state() is called automatically
whenever the API is asked for Satellites, which happens on every Mission
Control dashboard load, so in practice this satellite is warmed up well
before anyone reaches a route that needs it. A cold guard (nothing has
called runtime() yet at all) still fails safe - see
file_explorer/locked_folder_guard.py - so this is a convenience, not a
correctness requirement.
"""

from .runtime import runtime as runtime_module


def state(engine, satellite) -> dict:
    live = runtime_module(satellite)
    root = live.configured_root

    return {
        "configured": root is not None,
        "pin_set": live.pin_set,
    }
