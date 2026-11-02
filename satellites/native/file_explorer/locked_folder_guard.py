"""Recognizes the LockedFolder satellite's protected root, if one is
configured, so none of File Explorer's own routes can ever be used to reach
it without that session having unlocked it first - including by navigating
straight to its filesystem path, since every check here is a structural
"is this path inside the protected root", not "did the request come through
some particular UI flow". See docs/satellites/locked_folder.md.

File Explorer works exactly as it always has - unbounded, no configured
root of its own (see paths.py) - when no LockedFolder satellite is present,
disabled, or hasn't been given a path yet: there is nothing to guard
against, so every function below is a no-op in that case.
"""

from pathlib import Path

from starcore.api.response import error_response

LOCKED_FOLDER_NAME = "LockedFolder"


def _runtime(engine):
    """The LockedFolder satellite's live runtime object, or None if there is
    nothing to guard against (satellite absent or disabled). A runtime that
    hasn't been created yet is created here, so the first request after a
    restart is guarded like every other."""
    satellite = engine.registry.get(LOCKED_FOLDER_NAME)
    if satellite is None or not satellite.enabled:
        return None
    live = getattr(satellite, "locked_folder_runtime", None)
    if live is None and satellite.state_provider is not None:
        # nothing has created the runtime yet (e.g. the first request after a
        # restart): its state provider is the documented way to warm it up,
        # and without it this guard would let the vault through
        try:
            satellite.state_provider(engine, satellite)
        except Exception as error:
            print(f"[WARNING]: the Locked Folder could not be checked ({type(error).__name__}).")
        live = getattr(satellite, "locked_folder_runtime", None)
    return live


def is_protected(request, target: Path) -> bool:
    """Whether `target` is inside the configured Locked Folder root at all,
    regardless of this session's own unlock state - used to flag an entry
    in a directory listing so the frontend can show a lock icon."""
    live = _runtime(request.engine)
    return bool(live and live.protects(target))


def guard(request, target: Path):
    """None if `target` may be served by File Explorer as normal; otherwise
    the error_response the calling route should return instead - a single
    check every path-touching route in api.py runs before ever touching the
    filesystem, so there is exactly one place this protection can be
    bypassed from, and it is applied the same way no matter which route or
    which exact path under the root was requested."""
    live = _runtime(request.engine)
    if live is None or not live.protects(target):
        return None

    if live.is_unlocked(request.token):
        return None

    return error_response(
        "this location is inside the Locked Folder - unlock it from the Locked Folder page first",
        status=403,
    )


def guard_tree(request, target: Path):
    """guard(), plus a refusal for a folder that *contains* the Locked Folder:
    renaming or deleting one of those would move the vault out from under
    its configured path (unprotecting it) or erase it, without the PIN.
    Used by the routes that act on a whole directory tree - rename and delete."""
    blocked = guard(request, target)
    if blocked is not None:
        return blocked

    live = _runtime(request.engine)
    root = live.configured_root if live is not None else None
    if root is None or not root.is_relative_to(target) or live.is_unlocked(request.token):
        return None

    return error_response(
        "this folder contains the Locked Folder - unlock it from Photos first",
        status=403,
    )
