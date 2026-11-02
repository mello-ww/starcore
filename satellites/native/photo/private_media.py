"""What the Photo library must never take in: anything inside the Locked
Folder, and anything that was moved from Photos into it.

Photo and the Locked Folder stay separate satellites with separate data;
this only asks the Locked Folder's live runtime two yes/no questions, the
same narrow way File Explorer's locked_folder_guard.py does. It applies
whether or not the Locked Folder is currently enabled, since its files are
just as private either way.
"""

from pathlib import Path

LOCKED_FOLDER_NAME = "LockedFolder"


class PrivateMedia:
    def __init__(self, live=None):
        self._live = live

    def is_private(self, path) -> bool:
        """True for the vault itself and anything inside it."""
        return bool(self._live and self._live.protects(Path(path).resolve()))

    def is_sealed(self, digest: str) -> bool:
        """True for a photo that was moved from Photos into the Locked Folder."""
        return bool(self._live and self._live.is_sealed(digest))


NONE = PrivateMedia()


def policy(engine) -> PrivateMedia:
    if engine is None:
        return NONE
    satellite = engine.registry.get(LOCKED_FOLDER_NAME)
    if satellite is None:
        return NONE
    live = getattr(satellite, "locked_folder_runtime", None)
    if live is None and satellite.state_provider is not None:
        # the Locked Folder's state provider is its documented warm-up point
        try:
            satellite.state_provider(engine, satellite)
        except Exception:
            pass
        live = getattr(satellite, "locked_folder_runtime", None)
    return PrivateMedia(live)
