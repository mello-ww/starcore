"""The Services section: the engine, every satellite and what they depend on.

Everything here is read from the Core's own state (StarCore.status(),
StarCore.health(), the generic satellite status) - the same facts
Mission Control's Satellites page shows, gathered in one place. Optional
components are detected without importing or running them.
"""

from importlib.util import find_spec
import shutil
import time

from starcore.api.payloads import satellite_status

COMPONENT_SECONDS = 300
# (name, how it is found, what to look for, what needs it)
COMPONENTS = (
    ("Pillow", "python", "PIL", "Photo and Locked Folder thumbnails"),
    ("cryptography", "python", "cryptography", "Locked Folder encryption at rest"),
    ("FFmpeg", "program", "ffmpeg", "Music transcoding and video thumbnails"),
)

_components = {"at": 0.0, "found": []}


def components() -> list:
    if time.monotonic() - _components["at"] > COMPONENT_SECONDS or not _components["found"]:
        found = []
        for name, kind, target, purpose in COMPONENTS:
            try:
                available = bool(find_spec(target)) if kind == "python" else shutil.which(target) is not None
            except (ImportError, ValueError):
                available = False
            found.append({"name": name, "kind": kind, "available": available, "used_for": purpose})
        _components.update(at=time.monotonic(), found=found)
    return [dict(item) for item in _components["found"]]


def describe(engine) -> dict:
    status = engine.status()
    health = engine.health()
    registry = engine.command_registry.all()
    satellites, dependencies = [], []
    for satellite in engine.registry.all():
        name = satellite.manifest.name
        satellites.append({
            "name": name,
            "version": satellite.manifest.version,
            "type": satellite.type,
            "enabled": satellite.enabled,
            "status": satellite_status(engine, satellite),
            "service": satellite.has_service,
            "last_error": satellite.last_error,
            "commands": [command for command, entry in registry.items() if entry["source"] == name],
        })
        if satellite.manifest.section_of:
            dependencies.append({"satellite": name, "needs": satellite.manifest.section_of, "kind": "section"})
    mission_control = status["mission_control"]
    return {
        "engine": {
            "name": status["engine"],
            "running": status["running"],
            "uptime_seconds": status["uptime_seconds"],
            "commands": status["commands"],
            "satellite_services": engine.satellite_services_enabled,
            "mission_control": {"enabled": mission_control["enabled"], "running": mission_control["running"]},
        },
        "healthy": health["healthy"],
        "checks": health["checks"],
        "satellites": satellites,
        "online": sum(1 for satellite in satellites if satellite["status"] == "running"),
        "total": len(satellites),
        "dependencies": dependencies,
        "components": components(),
    }
