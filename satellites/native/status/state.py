"""Published to Mission Control and the app with every satellite listing.

A small, flat summary of the same snapshot the Status page reads (see
monitor.py), so Home can show health, CPU, memory and warnings from the
listing it already fetches - no extra request and no second measurement.
"""

from .monitor import monitor_for


def state(engine, satellite):
    if not satellite.enabled:
        return {}  # a disabled Status measures nothing; Home hides its summary
    return monitor_for(engine, satellite).summary()
