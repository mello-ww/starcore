"""What the Photo library must never take in: anything in a protected area on
disk, and anything that was moved from Photos into the Locked Folder.

Whether a path is protected is the Engine's answer (files.protected), as for
every Satellite: Photo names no provider for it. Whether a photo was moved into
the vault is still asked of the Locked Folder's live runtime, a narrow yes/no
question, until that too goes through a capability. Both apply whether or not
the Locked Folder is currently enabled, since its files are just as private
either way.
"""

from pathlib import Path

from starcore.capabilities import protection

LOCKED_FOLDER_NAME = "LockedFolder"


class PrivateMedia:
    def __init__(self, live=None, engine=None):
        self._live = live
        self._engine = engine

    def is_private(self, path) -> bool:
        """True for a protected area itself and anything inside it, whoever asks: Photo never
        takes it in, even from a session that has it open."""
        return bool(self._engine is not None
                    and protection(self._engine, Path(path).resolve()).protected)

    def is_sealed(self, digest: str) -> bool:
        """True for a photo that was moved from Photos into the Locked Folder."""
        return bool(self._live and self._live.is_sealed(digest))


NONE = PrivateMedia()


def policy(engine) -> PrivateMedia:
    if engine is None:
        return NONE
    satellite = engine.registry.get(LOCKED_FOLDER_NAME)
    if satellite is None:
        return PrivateMedia(None, engine)
    live = getattr(satellite, "locked_folder_runtime", None)
    if live is None and satellite.state_provider is not None:
        # the Locked Folder's state provider is its documented warm-up point
        try:
            satellite.state_provider(engine, satellite)
        except Exception:
            pass
        live = getattr(satellite, "locked_folder_runtime", None)
    return PrivateMedia(live, engine)
