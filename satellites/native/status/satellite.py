"""The Status satellite's background service: its metric sampler (see monitor.py)."""

from .monitor import monitor_for


def start(engine, satellite):
    monitor_for(engine, satellite).start()


def stop(engine, satellite):
    monitor_for(engine, satellite).stop()
