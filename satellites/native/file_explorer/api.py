"""Mission Control routes, served under /api/satellites/FileExplorer/.

Every operation turns its path(s) into a real filesystem Path through
paths.resolve_path() before touching anything - see paths.py for what that
does and does not guarantee. From there, the operating system's own
permissions decide what actually succeeds; this module's job is to turn
whatever it reports (missing, denied, not a directory, ...) into a clean,
specific response instead of a crash or a bare 500.
"""

from datetime import datetime, timezone
from pathlib import Path
from stat import S_ISDIR, S_ISREG
import shutil

from starcore.api.response import error_response, file_response, json_response

from . import locked_folder_guard, paths

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
        "upload": upload,
        "mkdir": mkdir,
        "rename": rename,
        "delete": delete,
    }


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
        return None, error_response(f"permission denied: {path}", status=403)
    except OSError as error:
        return None, error_response(f"the path could not be accessed ({error})", status=500)


def entries(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    raw_path = request.query.get("path", "")
    if raw_path == "":
        return json_response(_roots_listing())

    try:
        target = paths.resolve_path(raw_path)
    except paths.PathError as error:
        return error_response(str(error), status=400)

    blocked = locked_folder_guard.guard(request, target)
    if blocked is not None:
        return blocked

    status, failure = _stat(target)
    if failure is not None:
        return failure
    if not S_ISDIR(status.st_mode):
        return error_response("that path is a file, not a directory", status=400)

    try:
        listing = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    except PermissionError:
        return error_response(f"permission denied: {target}", status=403)
    except OSError as error:
        return error_response(f"the directory could not be read ({error})", status=500)

    items = []
    for item in listing:
        try:
            info = item.stat()
        except OSError:
            continue  # a broken symlink, a permission-denied entry, or one
                       # removed mid-listing - just skip it, don't fail the
                       # whole directory over one unreadable entry
        items.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "size": None if item.is_dir() else info.st_size,
            "modified": datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
            # flags the Locked Folder itself (or, in principle, anything
            # nested under it, though a listing never descends into a
            # locked directory in the first place - see guard() above) so
            # the frontend can show a lock icon; this is a visibility hint
            # only, never itself what keeps the contents inaccessible
            "locked": locked_folder_guard.is_protected(request, item),
        })

    return json_response({
        "path": str(target),
        "parent": paths.parent_of(target),
        "entries": items,
        "storage": _disk_usage(target),
    })


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

    blocked = locked_folder_guard.guard(request, target)
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

    # checked before even looking at the body, so a Locked Folder that isn't
    # unlocked refuses an upload attempt the same way it refuses anything
    # else here - never distinguishable from "the request was also malformed
    # some other way"
    blocked = locked_folder_guard.guard(request, directory)
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
        return error_response(f"permission denied: {directory}", status=403)
    except OSError as error:
        partial.unlink(missing_ok=True)
        return error_response(f"the upload could not be written ({error})", status=500)
    except ConnectionError as error:
        partial.unlink(missing_ok=True)
        return error_response(str(error), status=400)

    try:
        partial.replace(destination)
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

    blocked = locked_folder_guard.guard(request, directory)
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
        return error_response(f"permission denied: {directory}", status=403)
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

    blocked = locked_folder_guard.guard_tree(request, source)
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
        return error_response(f"permission denied: {source}", status=403)
    except OSError as error:
        return error_response(f"could not rename ({error})", status=500)

    return json_response({
        "name": destination.name,
        "path": str(destination),
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

    blocked = locked_folder_guard.guard_tree(request, target)
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
        return error_response(f"permission denied: {target}", status=403)
    except OSError as error:
        return error_response(f"could not delete ({error})", status=500)

    return json_response({"deleted": str(target)})
