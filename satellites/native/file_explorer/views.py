"""What File Explorer's shared interface (ui.json) shows, shaped from the same
listings the `entries` route answers with (api.py), and one file's details.
Read-only: every action in the document goes to the existing routes (mkdir,
rename, delete, upload, content), unchanged.

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


def _crumbs(target: Path) -> list:
    """The way down to `target`, one entry per level: the drive (or `/`), then each folder,
    each with the path it opens. The last is `target` itself."""
    crumbs, path = [], None
    for part in target.parts:
        path = Path(part) if path is None else path / part
        crumbs.append({"name": part.rstrip("\\/") or part, "path": str(path)})
    return crumbs


def folder_view(target: Path, parent, items: list, storage, folders_next=None, files_next=None,
                totals=None) -> dict:
    """One folder: its folders, then its files, and the way back up. `parent`
    is paths.parent_of(target): "" at a drive's root, where up is the list of
    locations. `items` may be one page of each; `folders_next` and
    `files_next` are then the cursors of the next pages (None at the end), and
    `totals` (folders, files) count the whole folder."""
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
    total_folders, total_files = totals if totals is not None else (len(folders), len(files))
    return {
        "path": str(target),
        "name": target.name or str(target),
        "parent": parent or None,
        "crumbs": _crumbs(target),
        "at_drive_root": parent == "",
        "folders": folders,
        "files": files,
        "folders_next": folders_next,
        "files_next": files_next,
        "total_folders": total_folders,
        "total_files": total_files,
        "has_folders": bool(total_folders),
        "has_files": bool(total_files),
        "empty": not total_folders and not total_files,
        "summary": _summary(total_folders, total_files),
        "storage": _storage_summary(storage) if storage else None,
    }


def _summary(folders: int, files: int) -> str:
    parts = []
    if folders:
        parts.append(f"{folders:,} {'folder' if folders == 1 else 'folders'}")
    if files:
        parts.append(f"{files:,} {'file' if files == 1 else 'files'}")
    return ", ".join(parts) or "Empty"


# what the file page previews with an `image` block: pictures both clients draw from the
# `content` route (an <img>, the app's Image), small enough to load whole. Others show no
# picture, only their details.
PICTURES = {".png": "PNG image", ".jpg": "JPEG image", ".jpeg": "JPEG image", ".gif": "GIF image",
            ".webp": "WebP image"}
PREVIEW_LIMIT = 20 * 1024 * 1024


# what the well-known extensions are, in words, for a file's Type; any other shows its
# extension ("XYZ file")
KINDS = {
    # applications and scripts
    ".exe": "Windows application", ".msi": "Windows installer", ".bat": "Windows batch script",
    ".cmd": "Windows command script", ".ps1": "PowerShell script", ".dll": "Windows library",
    ".lnk": "Windows shortcut", ".apk": "Android app", ".dmg": "macOS disk image",
    ".app": "macOS application", ".deb": "Debian package", ".rpm": "RPM package",
    ".appimage": "AppImage application", ".sh": "Shell script", ".jar": "Java archive",
    ".iso": "Disc image", ".img": "Disk image",
    # documents
    ".pdf": "PDF document", ".txt": "Text file", ".md": "Markdown document", ".rtf": "Rich text document",
    ".doc": "Word document", ".docx": "Word document", ".odt": "OpenDocument text",
    ".xls": "Excel spreadsheet", ".xlsx": "Excel spreadsheet", ".ods": "OpenDocument spreadsheet",
    ".csv": "CSV spreadsheet", ".ppt": "PowerPoint presentation", ".pptx": "PowerPoint presentation",
    ".odp": "OpenDocument presentation", ".epub": "EPUB book", ".log": "Log file",
    # data and code
    ".json": "JSON data", ".xml": "XML data", ".yaml": "YAML data", ".yml": "YAML data",
    ".toml": "TOML settings", ".ini": "Settings file", ".conf": "Settings file", ".cfg": "Settings file",
    ".env": "Environment settings", ".sql": "SQL script", ".db": "Database", ".sqlite": "SQLite database",
    ".html": "Web page", ".htm": "Web page", ".css": "Stylesheet", ".js": "JavaScript source",
    ".ts": "TypeScript source", ".py": "Python source", ".java": "Java source", ".c": "C source",
    ".cpp": "C++ source", ".h": "C header", ".cs": "C# source", ".go": "Go source", ".rs": "Rust source",
    ".kt": "Kotlin source", ".rb": "Ruby source", ".php": "PHP source",
    # archives
    ".zip": "ZIP archive", ".rar": "RAR archive", ".7z": "7-Zip archive", ".tar": "TAR archive",
    ".gz": "Gzip archive", ".tgz": "Gzip archive", ".bz2": "Bzip2 archive", ".xz": "XZ archive",
    # pictures the file page does not preview
    ".bmp": "Bitmap image", ".tif": "TIFF image", ".tiff": "TIFF image", ".svg": "SVG image",
    ".heic": "HEIC image", ".heif": "HEIF image", ".avif": "AVIF image", ".ico": "Icon",
    ".raw": "Camera raw image", ".dng": "Camera raw image", ".cr2": "Camera raw image",
    ".nef": "Camera raw image", ".arw": "Camera raw image", ".psd": "Photoshop image",
    # sound
    ".mp3": "MP3 audio", ".flac": "FLAC audio", ".wav": "WAV audio", ".ogg": "Ogg audio",
    ".opus": "Opus audio", ".m4a": "MPEG-4 audio", ".aac": "AAC audio", ".wma": "Windows Media audio",
    ".aiff": "AIFF audio", ".mid": "MIDI file", ".m3u": "Playlist", ".m3u8": "Playlist",
    # video
    ".mp4": "MPEG-4 video", ".mkv": "Matroska video", ".mov": "QuickTime video", ".avi": "AVI video",
    ".webm": "WebM video", ".wmv": "Windows Media video", ".m4v": "MPEG-4 video", ".srt": "Subtitles",
    # fonts
    ".ttf": "TrueType font", ".otf": "OpenType font", ".woff": "Web font", ".woff2": "Web font",
    # other
    ".torrent": "Torrent file", ".ics": "Calendar file", ".vcf": "Contact card", ".eml": "Email message",
    ".bak": "Backup file", ".tmp": "Temporary file", ".part": "Partial download",
}


def _kind(name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in PICTURES:
        return PICTURES[suffix]
    if suffix in KINDS:
        return KINDS[suffix]
    return f"{suffix[1:].upper()} file" if suffix else "File"


def file_view(target: Path, size: int, modified: float) -> dict:
    """One file's page: its details, its folder, and whether it is a picture to preview."""
    return {
        "name": target.name,
        "path": str(target),
        "folder": str(target.parent),
        "size": size,
        "modified": int(modified),
        "kind": _kind(target.name),
        "preview": target.suffix.lower() in PICTURES and size <= PREVIEW_LIMIT,
    }
