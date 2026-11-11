"""What File Explorer's shared interface (ui.json) shows, shaped from the same
listings the `entries` route answers with (api.py). Read-only: every action in
the document goes to the existing routes (mkdir, rename, delete, upload,
content), unchanged.

Dates are epoch seconds, sizes bytes, so each client formats them its own way
(the contract's `datetime` and `bytes` formats). Only the drive summaries are
text, since a list row has one subtitle.
"""

from datetime import datetime
from pathlib import Path


def _epoch(iso):
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso).timestamp())
    except ValueError:
        return None


def _bytes(size: int) -> str:
    """The contract's `bytes` format (powers of 1024), for a summary sentence."""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            break
        value /= 1024
    if unit == "B":
        return f"{int(value)} B"
    return f"{value:.1f}".rstrip("0").rstrip(".") + f" {unit}"


def _used_percent(storage):
    if not storage or not storage.get("total"):
        return None
    return round(storage["used"] * 100 / storage["total"], 1)


def _storage_summary(storage) -> str:
    if not storage:
        return "Storage unavailable"
    return f"{_bytes(storage['free'])} free of {_bytes(storage['total'])}"


def locations_view(listing: dict) -> dict:
    """The roots (drives on Windows, `/` elsewhere), each with its storage,
    and the machine's total across distinct volumes."""
    drives = [{
        "path": entry["name"],
        "title": entry["name"],
        "summary": _storage_summary(entry.get("storage")),
        "used_percent": _used_percent(entry.get("storage")),
    } for entry in listing["entries"]]
    machine = listing.get("machine")
    return {
        "drives": drives,
        "machine": None if not machine else {
            "used": machine["used"],
            "total": machine["total"],
            "free": machine["free"],
            "volumes": machine["volumes"],
        },
        "machine_summary": None if not machine else (
            f"{_bytes(machine['free'])} free across {machine['volumes']} "
            f"{'drive' if machine['volumes'] == 1 else 'drives'}"),
    }


def folder_view(target: Path, parent, items: list, storage) -> dict:
    """One folder: its folders, then its files, and the way back up. `parent`
    is paths.parent_of(target): "" at a drive's root, where up is the list of
    locations."""
    folders, files = [], []
    for item in items:
        row = {
            "name": item["name"],
            "path": str(target / item["name"]),
            "modified": _epoch(item.get("modified")),
        }
        if item["type"] == "dir":
            row["icon"] = "lock" if item.get("locked") else "folder"
            # in place of the date: a string passes through the datetime format as it is
            row["subtitle"] = "Locked" if item.get("locked") else row["modified"]
            folders.append(row)
        else:
            row["icon"] = "file"
            row["size"] = item.get("size")
            files.append(row)
    return {
        "path": str(target),
        "name": target.name or str(target),
        "parent": parent or None,
        "at_drive_root": parent == "",
        "folders": folders,
        "files": files,
        "has_folders": bool(folders),
        "has_files": bool(files),
        "empty": not folders and not files,
        "summary": _summary(len(folders), len(files)),
        "storage": _storage_summary(storage) if storage else None,
    }


def _summary(folders: int, files: int) -> str:
    parts = []
    if folders:
        parts.append(f"{folders} {'folder' if folders == 1 else 'folders'}")
    if files:
        parts.append(f"{files} {'file' if files == 1 else 'files'}")
    return ", ".join(parts) or "Empty"
