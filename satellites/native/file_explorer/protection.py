"""Keeps every route of File Explorer out of protected areas on disk, as the Engine answers for
them (starcore.capabilities.protection, the files.protected capability): a path in one is
refused unless this session has it open, including when someone navigates straight to its
filesystem path, since every check here is a structural "is this path in a protected area", not
"did the request come through some particular UI flow".

File Explorer names no provider. With none on the server, or none guarding anything, every
function below lets everything through, as it always has (see paths.py). A provider that is
disabled still guards, and one that can't answer keeps the path closed: the Engine sees to both.
See docs/satellites/locked_folder.md.
"""

from pathlib import Path

from starcore.api.response import error_response
from starcore.capabilities import protection


def guard(request, target: Path):
    """None if `target` may be served by File Explorer as normal; otherwise the error_response
    the calling route should return instead - a single check every path-touching route in
    api.py runs before ever touching the filesystem, so there is exactly one place this
    protection can be bypassed from."""
    return _refusal(protection(request.engine, target, request.token))


def guard_tree(request, target: Path):
    """guard(), plus a refusal for a folder that *contains* a protected area: renaming or
    deleting one of those would move the area out from under its provider's configured path
    (unprotecting it) or erase it. Used by the routes that act on a whole directory tree -
    rename and delete."""
    return _refusal(protection(request.engine, target, request.token, tree=True))


def marker(request, folder: Path):
    """For the entries of one listing of `folder`: a function telling whether an entry is in a
    protected area, to flag it with a lock - a visibility hint only, never what keeps its
    contents out of reach. One check for the folder as a tree; the entries are asked about
    only when the folder holds a protected area."""
    if not protection(request.engine, folder, request.token, tree=True).protected:
        return lambda path: False
    return lambda path: protection(request.engine, path, request.token).protected


def _refusal(answer):
    if answer.open:
        return None
    return error_response(answer.message, status=403)
