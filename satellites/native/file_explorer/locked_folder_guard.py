"""Recognizes the LockedFolder satellite's protected root, if one is
configured, so none of File Explorer's own routes can ever be used to reach
it without that session having unlocked it first - including by navigating
straight to its filesystem path, since every check here is a structural
"is this path inside the protected root", not "did the request come through
some particular UI flow". See docs/locked_folder.md.

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
    nothing to guard against right now (satellite absent, disabled, or the
    runtime hasn't been created yet - see locked_folder/runtime.py and
    locked_folder/state.py for why that's rare in practice, and safe here
    either way: no runtime found means guard() below simply lets everything
    through, which is correct when there is genuinely no Locked Folder
    configured, and merely a rare cold-start miss otherwise)."""
    satellite = engine.registry.get(LOCKED_FOLDER_NAME)
    if satellite is None or not satellite.enabled:
        return None
    return getattr(satellite, "locked_folder_runtime", None)


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
