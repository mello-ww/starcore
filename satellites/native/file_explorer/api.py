"""Mission Control routes, served under /api/satellites/FileExplorer/.

Every operation turns its path(s) into a real filesystem Path through
paths.resolve_path() before touching anything - see paths.py for what that
does and does not guarantee. From there, the operating system's own
permissions decide what actually succeeds; this module's job is to turn
whatever it reports (missing, denied, not a directory, ...) into a clean,
specific response instead of a crash or a bare 500.
"""

from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
import os
from stat import S_ISDIR, S_ISREG
import shutil

from starcore.api.response import error_response, file_response, json_response

from . import paths, protection, views

# a deliberately small, generic guess at content type for inline viewing -
# anything not listed here still downloads fine, just without a preview
CONTENT_TYPES = {
    ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".json": "application/json", ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".xml": "application/xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB - a sanity ceiling, not a product limit
READ_CHUNK = 256 * 1024


def routes() -> dict:
    return {
        "entries": entries,
        "content": content,
        # for other Satellites, through the files.browse capability (satellite.toml)
        "stat": stat,
        "locate": locate,
        "upload": upload,
        "mkdir": mkdir,
        "rename": rename,
        "delete": delete,
        # read-only: what ui.json shows (views.py)
        "view": view,
    }


def _refused(what: str, path: Path):
    """The answer when the system refuses StarCore a change or a read: a sentence a person can
    act on, naming the place by its name, not a raw "permission denied"."""
    place = path.name or str(path)
    return error_response(
        f"StarCore isn't allowed to {what} '{place}'. Its account on the server needs permission "
        "there.", status=403)


def _stat(path: Path):
    """path.stat(), reported as (status, error_response) - never raises, and
    never masks a permission problem as a plain 'not found' the way
    Path.exists()/is_dir()/is_file() would (they swallow every OSError)."""
    try:
        return path.stat(), None
    except FileNotFoundError:
        return None, error_response("no such file or directory", status=404)
    except NotADirectoryError:
        return None, error_response("a component of that path is not a directory", status=400)
    except PermissionError:
        return None, _refused("open", path)
    except OSError as error:
        return None, error_response(f"the path could not be accessed ({error})", status=500)


def entries(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    raw_path = request.query.get("path", "")
    if raw_path == "":
        return json_response(_roots_listing())

    target, items, failure = _read_directory(request, raw_path)
    if failure is not None:
        return failure
    return json_response({
        "path": str(target),
        "parent": paths.parent_of(target),
        "entries": items,
        "storage": _disk_usage(target),
    })


def _guarded_target(request):
    """The path of `?path=` as (target, its status, None), or (None, None, an error response)
    when it is malformed, protected, missing or unreadable: the one check `stat` and `locate`
    share with `content`, so a Satellite asking on a user's behalf learns nothing the user
    could not browse to."""
    try:
        target = paths.resolve_path(request.query.get("path", ""))
    except paths.PathError as error:
        return None, None, error_response(str(error), status=400)
    blocked = protection.guard(request, target)
    if blocked is not None:
        return None, None, blocked
    status, failure = _stat(target)
    if failure is not None:
        return None, None, failure
    return target, status, None


def stat(request):
    """stat?path=: one file or folder the session may browse (files.browse's `stat`), or the
    error `content` would give. Other Satellites ask it before they touch a path."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    target, status, failure = _guarded_target(request)
    if failure is not None:
        return failure
    if not (S_ISREG(status.st_mode) or S_ISDIR(status.st_mode)):
        return error_response("that path is neither a file nor a folder", status=400)
    is_dir = S_ISDIR(status.st_mode)
    return json_response({
        "name": target.name or str(target),
        "path": str(target),
        "type": "dir" if is_dir else "file",
        "size": None if is_dir else status.st_size,
        "modified": datetime.fromtimestamp(status.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
    })


def locate(request):
    """locate?path=: which of this interface's pages shows a path (files.browse's `locate`):
    the folder page of a file's folder with the file named in `select`, or of the folder
    itself."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    target, status, failure = _guarded_target(request)
    if failure is not None:
        return failure
    if S_ISDIR(status.st_mode):
        return json_response({"page": "folder", "params": {"path": str(target)}})
    if not S_ISREG(status.st_mode):
        return error_response("that path is neither a file nor a folder", status=400)
    return json_response({"page": "folder", "params": {"path": str(target.parent), "select": target.name}})


def view(request):
    """The interface's own read-only routes, shaped for ui.json (see views.py):
    `view/locations`, `view/folder?path=` and `view/file?path=`. Every action
    there goes to the routes below, unchanged."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    where = tuple(request.path)
    if where == ("locations",):
        return json_response(views.locations_view(_roots_listing()))
    if where == ("folder",):
        return _folder_view(request)
    if where == ("file",):
        return _file_view(request)
    return error_response(f"unknown endpoint 'view/{'/'.join(where)}'")


# a page of view/folder: the interface's lists arrive this many rows at a time (UI contract 1.2's
# `more` on a list), however large the folder
PAGE_SIZE = 200
MAX_PAGE_SIZE = 500


def _folder_view(request):
    """view/folder?path=[&part=folders|files&cursor=&limit=]: without `part`, the first page of
    the folder's folders and the first page of its files; with it, the page of that part after
    `cursor` (the last name the previous page held). Only the rows of the page are examined."""
    part = request.query.get("part", "")
    if part not in ("", "folders", "files"):
        return error_response("'part' must be folders or files", status=400)
    raw_limit = request.query.get("limit", "")
    try:
        limit = PAGE_SIZE if raw_limit == "" else int(raw_limit)
    except ValueError:
        limit = 0
    if limit < 1:
        return error_response("'limit' must be a positive number", status=400)
    limit = min(limit, MAX_PAGE_SIZE)
    cursor = request.query.get("cursor", "")

    target, folders, files, failure = _scan_directory(request, request.query.get("path", ""))
    if failure is not None:
        return failure
    shown, following = [], {}
    for name, entries in (("folders", folders), ("files", files)):
        if part in ("", name):
            chosen, following[name] = _page(entries, cursor if part == name else "", limit)
            shown += chosen
    return json_response(views.folder_view(
        target, paths.parent_of(target), _describe(request, target, shown),
        _disk_usage(target) if part == "" else None,
        folders_next=following.get("folders"), files_next=following.get("files"),
        totals=(len(folders), len(files))))


def _file_view(request):
    """view/file?path=: one file's details, behind the same guard as its content."""
    try:
        target = paths.resolve_path(request.query.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    blocked = protection.guard(request, target)
    if blocked is not None:
        return blocked

    status, failure = _stat(target)
    if failure is not None:
        return failure
    if not S_ISREG(status.st_mode):
        return error_response("that path is not a file", status=400)
    return json_response(views.file_view(target, status.st_size, status.st_mtime))


def _sort_key(name: str):
    """Names as people read them (case-insensitive), then exactly, so two names that differ
    only by case keep one order from page to page."""
    return name.lower(), name


def _page(entries, cursor: str, limit: int):
    """(the entries after `cursor`, at most `limit` of them; the cursor of the page after, or
    None at the end). A cursor is a name, so a page carries on after it even if that name has
    gone since, and nothing already shown comes back."""
    start = 0
    if cursor:
        after = _sort_key(cursor)
        keys = [_sort_key(entry.name) for entry in entries]
        start = bisect_right(keys, after)
    chosen = entries[start:start + limit]
    return chosen, chosen[-1].name if chosen and start + limit < len(entries) else None


def _read_directory(request, raw_path):
    """One directory's entries, folders first: (target, items, None), or
    (None, None, an error response) when the path is malformed, protected,
    missing, not a directory or unreadable."""
    target, folders, files, failure = _scan_directory(request, raw_path)
    if failure is not None:
        return None, None, failure
    return target, _describe(request, target, folders + files), None


def _scan_directory(request, raw_path):
    """One directory's folders and files as os.DirEntry, each sorted by name, nothing examined
    beyond what the directory read itself gives: (target, folders, files, None), or
    (None, None, None, an error response) when the path is malformed, protected, missing, not
    a directory or unreadable."""
    try:
        target = paths.resolve_path(raw_path)
    except paths.PathError as error:
        return None, None, None, error_response(str(error), status=400)

    blocked = protection.guard(request, target)
    if blocked is not None:
        return None, None, None, blocked

    status, failure = _stat(target)
    if failure is not None:
        return None, None, None, failure
    if not S_ISDIR(status.st_mode):
        return None, None, None, error_response("that path is a file, not a directory", status=400)

    # os.scandir rather than Path.iterdir: each entry comes with its type (and,
    # on Windows, its stat) from the directory read itself, so a folder of
    # thousands of entries lists in a fraction of a second rather than
    # seconds. Like Path.is_dir()/stat(), a DirEntry follows symlinks.
    try:
        with os.scandir(target) as found:
            listing = list(found)
    except PermissionError:
        return None, None, None, _refused("read the folder", target)
    except OSError as error:
        return None, None, None, error_response(f"the directory could not be read ({error})", status=500)

    folders, files = [], []
    for entry in listing:
        try:
            is_dir = entry.is_dir()  # from the directory read itself on Linux and Windows
        except OSError:
            continue
        (folders if is_dir else files).append(entry)
    folders.sort(key=lambda entry: _sort_key(entry.name))
    files.sort(key=lambda entry: _sort_key(entry.name))
    return target, folders, files, None


def _describe(request, target: Path, entries) -> list:
    """The rows for `entries`, in their order: size, date and the protected-area flag. Only
    these entries are examined (a stat each on Linux), so a page costs its own rows."""
    rows = []
    for entry in entries:
        try:
            info = entry.stat()
            is_dir = entry.is_dir()
        except OSError:
            continue  # a broken symlink, a permission-denied entry, or one
                       # removed mid-listing - just skip it, don't fail the
                       # whole directory over one unreadable entry
        rows.append((is_dir, entry.name, info))

    # flags a protected area (or, in principle, anything nested in one, though
    # a listing never descends into a closed one in the first place - see
    # guard()) so the frontend can show a lock icon; this is a visibility hint
    # only, never itself what keeps the contents inaccessible
    protects = protection.marker(request, target)
    items = [{
        "name": name,
        "type": "dir" if is_dir else "file",
        "size": None if is_dir else info.st_size,
        "modified": datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        "locked": protects(target / name),
    } for is_dir, name, info in rows]
    return items


def _disk_usage(path: Path):
    """total/used/free bytes for the filesystem/drive containing `path`, or
    None if that can't be determined right now.

    shutil.disk_usage() already does exactly what's needed here on both
    platforms - given any path (not just a mount point or drive root) it
    resolves to the containing filesystem via statvfs() on POSIX or
    GetDiskFreeSpaceExW() on Windows, so nothing here has to guess at mount
    points or special-case drive letters itself. Never raises: a filesystem
    that vanished mid-request, a network mount that's timed out, or any
    other OSError all just mean "not available right now" rather than a
    failed listing - the frontend hides storage figures it doesn't have
    instead of showing something misleading.
    """
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    return {"total": usage.total, "used": usage.used, "free": usage.free}


def _volume_id(path: Path):
    """A best-effort identifier for the physical/logical volume `path` sits
    on - used only to avoid double-counting the same volume twice in
    _machine_storage() below, never exposed to the frontend. os.stat()'s
    st_dev is already exactly this on both platforms (a POSIX device
    number, or Windows' equivalent per-volume identifier), so there's no
    need to special-case drive letters vs. mount points here either."""
    try:
        return path.stat().st_dev
    except OSError:
        return None


def _machine_storage(roots) -> dict:
    """Total/used/free across every distinct volume `roots` touches, each
    counted exactly once - the whole point being that simply summing every
    root's own disk_usage() would double-count a volume File Explorer can
    reach from more than one root (e.g. a Windows drive that is also
    mount-pointed somewhere else). Returns None if none of the roots could
    report usable storage information at all."""
    seen_volumes = set()
    total = used = free = 0
    counted = 0
    for root in roots:
        volume_id = _volume_id(root)
        if volume_id is not None and volume_id in seen_volumes:
            continue
        usage = _disk_usage(root)
        if usage is None:
            continue
        if volume_id is not None:
            seen_volumes.add(volume_id)
        total += usage["total"]
        used += usage["used"]
        free += usage["free"]
        counted += 1
    if counted == 0:
        return None
    return {"total": total, "used": used, "free": free, "volumes": counted}


def _roots_listing() -> dict:
    """The virtual top level: every root File Explorer offers to browse
    from ('/' on Linux/macOS, every present drive letter on Windows) - not
    itself a real directory, so it has no parent to go up to.

    Also carries the storage dashboard's two other figures: each root's own
    total/used/free (`storage`, per entry - None if unavailable), and the
    machine-wide total across every distinct volume (`machine`, deduplicated -
    see _machine_storage()). Neither changes what browsing into a root does;
    both are additive fields an older frontend would simply ignore.
    """
    roots = paths.list_roots()
    items = [{"name": str(root), "type": "dir", "size": None, "modified": None,
              "storage": _disk_usage(root)}
             for root in roots]
    return {"path": "", "parent": None, "entries": items, "storage": None,
            "machine": _machine_storage(roots)}


def content(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    try:
        target = paths.resolve_path(request.query.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    blocked = protection.guard(request, target)
    if blocked is not None:
        return blocked

    status, failure = _stat(target)
    if failure is not None:
        return failure
    if not S_ISREG(status.st_mode):
        return error_response("that path is not a file", status=400)

    content_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
    force_download = request.query.get("download") == "1" or content_type == "application/octet-stream"

    return file_response(target, content_type, cache="private, no-store",
                          download_name=target.name if force_download else None)


def upload(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    try:
        directory = paths.resolve_path(request.query.get("path", ""))
        name = paths.safe_name(request.query.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    # checked before even looking at the body, so a protected area that isn't
    # open refuses an upload attempt the same way it refuses anything
    # else here - never distinguishable from "the request was also malformed
    # some other way"
    blocked = protection.guard(request, directory)
    if blocked is not None:
        return blocked

    if request.raw is None:
        return error_response("expected a raw file body, not JSON", status=400)

    status, failure = _stat(directory)
    if failure is not None:
        return failure
    if not S_ISDIR(status.st_mode):
        return error_response("the destination is not a directory", status=400)

    if request.raw.length <= 0:
        return error_response("the upload was empty", status=400)
    if request.raw.length > MAX_UPLOAD_BYTES:
        return error_response(f"the upload is larger than {MAX_UPLOAD_BYTES} bytes", status=413)

    destination = directory / name
    overwrite = request.query.get("overwrite") == "1"
    if destination.exists() and not overwrite:
        return error_response(f"'{name}' already exists", status=409)

    # written aside first and only renamed into place once the whole upload
    # has arrived - a connection that drops mid-upload can never leave a
    # half-written file at the real destination
    partial = directory / f".{name}.part"
    try:
        with open(partial, "wb") as file:
            remaining = request.raw.length
            while remaining > 0:
                chunk = request.raw.read(min(READ_CHUNK, remaining))
                if not chunk:
                    raise ConnectionError("the upload ended early")
                file.write(chunk)
                remaining -= len(chunk)
    except PermissionError:
        partial.unlink(missing_ok=True)
        return _refused("upload into", directory)
    except OSError as error:
        partial.unlink(missing_ok=True)
        return error_response(f"the upload could not be written ({error})", status=500)
    except ConnectionError as error:
        partial.unlink(missing_ok=True)
        return error_response(str(error), status=400)

    try:
        partial.replace(destination)
    except PermissionError:
        # the folder takes new files but the one being replaced is locked or read-only
        partial.unlink(missing_ok=True)
        return _refused("replace", destination)
    except OSError as error:
        partial.unlink(missing_ok=True)
        return error_response(f"the upload could not be finalized ({error})", status=500)

    info = destination.stat()
    return json_response({
        "name": destination.name,
        "path": str(destination),
        "size": info.st_size,
    })


def mkdir(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    body = request.body or {}
    try:
        directory = paths.resolve_path(body.get("path", ""))
        name = paths.safe_name(body.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    blocked = protection.guard(request, directory)
    if blocked is not None:
        return blocked

    status, failure = _stat(directory)
    if failure is not None:
        return failure
    if not S_ISDIR(status.st_mode):
        return error_response("the parent is not a directory", status=400)

    target = directory / name
    if target.exists():
        return error_response(f"'{name}' already exists", status=409)

    try:
        target.mkdir()
    except PermissionError:
        return _refused("create a folder in", directory)
    except FileExistsError:
        return error_response(f"'{name}' already exists", status=409)
    except OSError as error:
        return error_response(f"the directory could not be created ({error})", status=500)

    return json_response({"name": target.name, "path": str(target)})


def rename(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    body = request.body or {}
    try:
        source = paths.resolve_path(body.get("path", ""))
        new_name = paths.safe_name(body.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if paths.is_filesystem_root(source):
        return error_response("a filesystem root cannot be renamed", status=400)

    blocked = protection.guard_tree(request, source)
    if blocked is not None:
        return blocked

    _, failure = _stat(source)
    if failure is not None:
        return failure

    destination = source.parent / new_name
    if destination.exists():
        return error_response(f"'{new_name}' already exists", status=409)

    try:
        source.rename(destination)
    except PermissionError:
        return _refused("rename", source)
    except OSError as error:
        return error_response(f"could not rename ({error})", status=500)

    return json_response({
        "name": destination.name,
        "path": str(destination),
        "folder": str(destination.parent),
        "type": "dir" if destination.is_dir() else "file",
    })


def delete(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    body = request.body or {}
    try:
        target = paths.resolve_path(body.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if paths.is_filesystem_root(target):
        return error_response("a filesystem root cannot be deleted", status=400)

    blocked = protection.guard_tree(request, target)
    if blocked is not None:
        return blocked

    _, failure = _stat(target)
    if failure is not None:
        return failure

    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    except PermissionError:
        return _refused("delete", target)
    except OSError as error:
        return error_response(f"could not delete ({error})", status=500)

    return json_response({"deleted": str(target)})
