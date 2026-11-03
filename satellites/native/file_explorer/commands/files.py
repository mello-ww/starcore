"""files - storage figures and metadata only. No listing, reading, writing or deleting.

Paths go through File Explorer's own resolve_path() and the same Locked
Folder guard its routes use, so nothing inside the Locked Folder is ever
described here, whoever asks.
"""

from datetime import datetime, timezone
import stat as stat_module

from starcore.cli.runner import table
from starcore.cli.spec import Argument, Command, CommandError, NotFound, PermissionDenied, UsageError

from .. import locked_folder_guard, paths
from ..api import _roots_listing

NAMESPACE = "files"
SUMMARY = "Storage usage and safe file metadata"
DEFAULT = "storage"

READ = "files.read"


def storage(ctx):
    listing = _roots_listing()
    return {"volumes": [{"root": entry["name"], **(entry["storage"] or {"total": None, "used": None, "free": None})}
                        for entry in listing["entries"]],
            "machine": listing["machine"]}


def _size(value) -> str:
    if value is None:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def _render_storage(data: dict) -> str:
    rows = [{"root": volume["root"], "total": _size(volume["total"]), "used": _size(volume["used"]),
             "free": _size(volume["free"])} for volume in data["volumes"]]
    text = table(rows, [("root", "Root"), ("total", "Total"), ("used", "Used"), ("free", "Free")])
    machine = data["machine"]
    if machine:
        text += (f"\n\nMachine: {_size(machine['free'])} free of {_size(machine['total'])} "
                 f"across {machine['volumes']} volume(s)")
    return text


def describe_path(ctx, path):
    try:
        target = paths.resolve_path(path)
    except paths.PathError as error:
        raise UsageError(str(error))

    live = locked_folder_guard._runtime(ctx.engine)
    if live is not None and live.protects(target):
        raise PermissionDenied("that location is inside the Locked Folder")

    try:
        info = target.stat()
    except FileNotFoundError:
        raise NotFound(f"no such file or directory: {target}")
    except PermissionError:
        raise PermissionDenied(f"permission denied: {target}")
    except OSError as error:
        raise CommandError(f"the path could not be accessed ({error})")

    is_dir = stat_module.S_ISDIR(info.st_mode)
    result = {
        "path": str(target),
        "type": "dir" if is_dir else "file" if stat_module.S_ISREG(info.st_mode) else "other",
        "size": None if is_dir else info.st_size,
        "modified": datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        "contains_locked_folder": bool(is_dir and live is not None and live.configured_root is not None
                                       and live.configured_root.is_relative_to(target)),
    }
    if is_dir:
        try:
            children = list(target.iterdir())
            result["entries"] = len(children)
        except OSError:
            result["entries"] = None
    return result


COMMANDS = [
    Command("storage", "Total, used and free space on every volume", storage, READ, render=_render_storage,
            examples=("files", "files storage --json")),
    Command("stat", "Type, size and modification time of one path", describe_path, READ,
            arguments=(Argument("path", "an absolute path on this machine"),), remote=False,
            examples=("files stat \"D:\\Media\"", "files stat /srv/media --json")),
]
