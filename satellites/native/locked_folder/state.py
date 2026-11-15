"""Published to Mission Control's dashboard (see docs/satellites.md,
"Publishing state"). Nothing depends on it to create the runtime: every
route, the Engine's questions (files.protected's check, media.vault's
sealed) included, creates it on first use (see runtime.py), so a cold
start is guarded without it.
"""

from .runtime import runtime as runtime_module


def state(engine, satellite) -> dict:
    live = runtime_module(satellite)
    root = live.configured_root

    return {
        "configured": root is not None,
        "pin_set": live.pin_set,
    }
