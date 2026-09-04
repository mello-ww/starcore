"""Mission Control routes, served under /api/satellites/file_explorer/.

Every operation resolves its path(s) through paths.resolve() before touching
the filesystem - see paths.py for the actual security boundary. Nothing here
ever builds a filesystem path by concatenating a request value onto the root
itself; that's exactly the mistake resolve() exists to make impossible.
"""

from datetime import datetime, timezone
from pathlib import Path
import shutil

from starcore.api.response import error_response, file_response, json_response

from . import configuration, paths

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
        # naming a route "configuration" is the whole contract with the Core's
        # generic satellite configuration mechanism - see docs/satellites.md
        "configuration": configuration_route,
    }


def configuration_route(request):
    if request.method == "GET":
        return json_response(configuration.describe(request.satellite))

    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    body = request.body or {}
    key, value = body.get("key"), body.get("value")
    if not isinstance(key, str):
        return error_response("'key' must be a string", status=400)

    try:
        return json_response(configuration.update(request.satellite, key, value))
    except configuration.ConfigurationError as error:
        return error_response(str(error), status=400)


def entries(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    root = paths.storage_root(request.satellite)
    try:
        target = paths.resolve(root, request.query.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if not target.exists():
        return error_response("no such directory", status=404)
    if not target.is_dir():
        return error_response("that path is a file, not a directory", status=400)

    try:
        listing = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    except OSError as error:
        return error_response(f"the directory could not be read ({error})", status=500)

    items = []
    for item in listing:
        try:
            info = item.stat()
        except OSError:
            continue  # a broken symlink or a file removed mid-listing - just skip it
        items.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "size": None if item.is_dir() else info.st_size,
            "modified": datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        })

    relative = paths.relative_path(root, target)
    parent = None if target == root else "/".join(relative.split("/")[:-1])

    return json_response({
        "root": str(root),
        "path": relative,
        "parent": parent,
        "entries": items,
    })


def content(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    root = paths.storage_root(request.satellite)
    try:
        target = paths.resolve(root, request.query.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if not target.is_file():
        return error_response("no such file", status=404)

    content_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
    force_download = request.query.get("download") == "1" or content_type == "application/octet-stream"

    return file_response(target, content_type, cache="private, no-store",
                          download_name=target.name if force_download else None)


def upload(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if request.raw is None:
        return error_response("expected a raw file body, not JSON", status=400)

    root = paths.storage_root(request.satellite)
    try:
        directory = paths.resolve(root, request.query.get("path", ""))
        name = paths.safe_name(request.query.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if not directory.is_dir():
        return error_response("the destination directory does not exist", status=404)
    if request.raw.length <= 0:
        return error_response("the upload was empty", status=400)
    if request.raw.length > MAX_UPLOAD_BYTES:
        return error_response(f"the upload is larger than {MAX_UPLOAD_BYTES} bytes", status=413)

    destination = directory / name
    # is_relative_to() would already be guaranteed by directory being resolved
    # inside root and name having no separators (paths.safe_name), but this is
    # the one place a file is actually created, so it's checked again directly
    try:
        paths.resolve(root, f"{paths.relative_path(root, directory)}/{name}".strip("/"))
    except paths.PathError as error:
        return error_response(str(error), status=400)

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
    except OSError as error:
        partial.unlink(missing_ok=True)
        return error_response(f"the upload could not be written ({error})", status=500)
    except ConnectionError as error:
        partial.unlink(missing_ok=True)
        return error_response(str(error), status=400)

    partial.replace(destination)
    info = destination.stat()
    return json_response({
        "name": destination.name,
        "path": paths.relative_path(root, destination),
        "size": info.st_size,
    })


def mkdir(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    root = paths.storage_root(request.satellite)
    body = request.body or {}
    try:
        directory = paths.resolve(root, body.get("path", ""))
        name = paths.safe_name(body.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if not directory.is_dir():
        return error_response("the parent directory does not exist", status=404)

    target = directory / name
    if target.exists():
        return error_response(f"'{name}' already exists", status=409)

    try:
        target.mkdir()
    except OSError as error:
        return error_response(f"the directory could not be created ({error})", status=500)

    return json_response({"name": target.name, "path": paths.relative_path(root, target)})


def rename(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    root = paths.storage_root(request.satellite)
    body = request.body or {}
    try:
        source = paths.resolve(root, body.get("path", ""))
        new_name = paths.safe_name(body.get("name", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if source == root:
        return error_response("the root directory cannot be renamed", status=400)
    if not source.exists():
        return error_response("no such file or directory", status=404)

    destination = source.parent / new_name
    try:
        paths.resolve(root, paths.relative_path(root, destination))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if destination.exists():
        return error_response(f"'{new_name}' already exists", status=409)

    try:
        source.rename(destination)
    except OSError as error:
        return error_response(f"could not rename ({error})", status=500)

    return json_response({
        "name": destination.name,
        "path": paths.relative_path(root, destination),
        "type": "dir" if destination.is_dir() else "file",
    })


def delete(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    root = paths.storage_root(request.satellite)
    body = request.body or {}
    try:
        target = paths.resolve(root, body.get("path", ""))
    except paths.PathError as error:
        return error_response(str(error), status=400)

    if target == root:
        return error_response("the root directory cannot be deleted", status=400)
    if not target.exists():
        return error_response("no such file or directory", status=404)

    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError as error:
        return error_response(f"could not delete ({error})", status=500)

    return json_response({"deleted": paths.relative_path(root, target)})
