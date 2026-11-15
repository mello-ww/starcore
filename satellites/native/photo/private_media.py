"""What the Photo library must never take in: anything in a protected area on
disk, and anything that was moved from Photos into a protected store.

Both are the Engine's answers, as for every Satellite: whether a path is
protected (files.protected), and whether a file was moved into a store
(media.vault's sealed). Photo names no provider for either. The Engine asks
every provider, enabled or not, since what they hold is just as private either
way, and one that can't answer keeps the file out.
"""

from pathlib import Path

from starcore.capabilities import protection, sealed


class PrivateMedia:
    def __init__(self, engine=None):
        self._engine = engine

    def is_private(self, path) -> bool:
        """True for a protected area itself and anything inside it, whoever asks: Photo never
        takes it in, even from a session that has it open."""
        return bool(self._engine is not None
                    and protection(self._engine, Path(path).resolve()).protected)

    def is_sealed(self, digest: str) -> bool:
        """True for a file that was moved from Photos into a protected store."""
        return bool(self._engine is not None and sealed(self._engine, digest))


NONE = PrivateMedia()


def policy(engine) -> PrivateMedia:
    return NONE if engine is None else PrivateMedia(engine)
