"""Published to Mission Control and the app with every satellite listing.

A small, flat summary of the same snapshot the Status page reads (see
monitor.py), so Home can show health, CPU, memory and warnings from the
listing it already fetches - no extra request and no second measurement.
The same summary is what Status's Home widget (ui.json "widgets") binds to,
so it also carries the widget's display keys (view.widget).
"""

from .monitor import monitor_for
from .view import widget


def state(engine, satellite):
    if not satellite.enabled:
        return {}  # a disabled Status measures nothing; Home hides its summary
    summary = monitor_for(engine, satellite).summary()
    return {**summary, **widget(summary)}
