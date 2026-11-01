"""Music's only background work: the optional scheduled rescan (scan_interval minutes)."""

from datetime import datetime, timezone
from threading import Event, Thread

from .library import MusicScanError, library

TICK_SECONDS = 60

_services = {}


def start(engine, satellite):
    stop(engine, satellite)
    stopping = Event()
    thread = Thread(target=_run, args=(satellite, stopping), name="starcore-music-scheduler", daemon=True)
    _services[id(satellite)] = (thread, stopping)
    thread.start()


def stop(engine, satellite):
    service = _services.pop(id(satellite), None)
    if service is not None:
        service[1].set()
        service[0].join(timeout=5)


def _run(satellite, stopping: Event):
    while not stopping.wait(TICK_SECONDS):
        try:
            _tick(satellite)
        except Exception as error:
            print(f"[WARNING]: scheduled music scan failed: {error}")


def _tick(satellite):
    interval = int(satellite.config.get("scan_interval", 0) or 0)
    if interval <= 0:
        return
    music = library(satellite)
    last = music.last_scan
    if last:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds()
        if elapsed < interval * 60:
            return
    try:
        music.scan_in_background()
    except MusicScanError:
        pass
