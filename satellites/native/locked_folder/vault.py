"""Reading the vault as a media library, and verified moves to and from Photos.

Listing and serving only ever touch paths that resolve inside the configured
root, so a symlink or ".." can never reach outside it.

Moves never delete anything until the copy on the other side has been
written, flushed to disk and re-read with a matching SHA-256 digest. On any
failure before that point the half-made copy is removed and the original is
left exactly where it was.
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import os
import secrets
import threading

PHOTO_SATELLITE = "Photo"
MOVED_IN_FOLDER = "Photos"     # where photos moved in from the Photo library land
MAX_ITEMS = 20000
READ_SIZE = 1024 * 1024

MEDIA_TYPES = {
    ".jpg": ("photo", "image/jpeg"),
    ".jpeg": ("photo", "image/jpeg"),
    ".png": ("photo", "image/png"),
    ".webp": ("photo", "image/webp"),
    ".gif": ("photo", "image/gif"),
    ".heic": ("photo", "image/heic"),
    ".mp4": ("video", "video/mp4"),
    ".m4v": ("video", "video/mp4"),
    ".mov": ("video", "video/quicktime"),
    ".3gp": ("video", "video/3gpp"),
    ".webm": ("video", "video/webm"),
}

# one move at a time: the Photo library index and the vault are both plain
# files, and two overlapping moves of the same photo must not interleave
_move_lock = threading.Lock()


class VaultError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def describe(path: Path, root: Path) -> dict:
    stat = path.stat()
    media_type, content_type = MEDIA_TYPES.get(path.suffix.lower(), ("file", "application/octet-stream"))
    return {
        "path": path.relative_to(root).as_posix(),
        "name": path.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        "media_type": media_type,
        "content_type": content_type,
    }


def list_items(root: Path) -> dict:
    """Every file in the vault (newest first), each tagged photo/video/file.
    Hidden files and in-progress copies are left out."""
    items = []
    truncated = False
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if not name.startswith("."))
        for name in files:
            if name.startswith(".") or name.endswith(".part"):
                continue
            path = Path(directory) / name
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(root) or not resolved.is_file():
                    continue
                items.append(describe(path, root))
            except (OSError, ValueError):
                continue
            if len(items) >= MAX_ITEMS:
                truncated = True
                break
        if truncated:
            break
    items.sort(key=lambda item: item["modified"], reverse=True)
    return {"items": items, "truncated": truncated}


def resolve_item(root: Path, relative) -> Path:
    if not isinstance(relative, str) or not relative.strip() or "\x00" in relative:
        raise VaultError("'path' must name a file inside the Locked Folder")
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target == root:
        raise VaultError("that path is outside the Locked Folder", status=403)
    if not target.is_file():
        raise VaultError("no such file in the Locked Folder", status=404)
    return target


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as file:
        while chunk := file.read(READ_SIZE):
            hasher.update(chunk)
    return hasher.hexdigest()


def copy_verified(source: Path, destination_dir: Path, name: str, expected: str) -> Path:
    """Copies `source` into `destination_dir` under a free variant of `name`,
    flushed to disk and checked against `expected` before it gets its final
    name. Never overwrites an existing file."""
    destination_dir.mkdir(parents=True, exist_ok=True)
    partial = destination_dir / f".{secrets.token_hex(8)}.part"
    try:
        with open(source, "rb") as reader, open(partial, "xb") as writer:
            while chunk := reader.read(READ_SIZE):
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if digest(partial) != expected:
            raise VaultError("the copy did not match the original, so nothing was moved", status=500)
        target = _free_name(destination_dir, name)
        os.rename(partial, target)  # target was just checked free; rename never follows into another dir
        return target
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def _free_name(directory: Path, name: str) -> Path:
    clean = _safe_name(name)
    stem, suffix = os.path.splitext(clean)
    candidate = directory / clean
    counter = 1
    while candidate.exists():
        candidate = directory / f"{stem} ({counter}){suffix}"
        counter += 1
    return candidate


def _safe_name(name) -> str:
    text = Path(str(name or "")).name.strip().replace("\x00", "")
    for character in '<>:"/\\|?*':
        text = text.replace(character, "_")
    text = text.lstrip(".")
    return text[:180] or "photo"


# ---------- moves ----------

def photo_library(engine):
    """The Photo satellite's live library, or None when Photo isn't loaded."""
    satellite = engine.registry.get(PHOTO_SATELLITE)
    if satellite is None:
        return None
    try:
        # loaded lazily and by its registered package name, the same module
        # object Photo's own routes use (so one in-memory index, not two)
        from satellites.native.photo.library import library
    except ImportError:
        return None
    return library(satellite)


def move_in(engine, live, root: Path, photo_ids) -> dict:
    """Moves photos out of the Photo library into the vault's Photos folder."""
    library = photo_library(engine)
    if library is None:
        raise VaultError("the Photo satellite is not available", status=503)
    if not isinstance(photo_ids, list) or not photo_ids or not all(isinstance(item, str) for item in photo_ids):
        raise VaultError("'photo_ids' must be a non-empty list of photo ids")

    moved, failed = [], []
    with _move_lock:
        for photo_id in dict.fromkeys(photo_ids):
            try:
                moved.append(_move_one_in(live, library, root, photo_id))
                _forget_in_albums(engine, library)
            except VaultError as error:
                failed.append({"id": photo_id, "reason": str(error)})
            except OSError as error:
                failed.append({"id": photo_id, "reason": f"the file could not be copied ({error.strerror or error})"})
            except Exception as error:
                print(f"[WARNING]: moving a photo into the Locked Folder failed ({type(error).__name__}).")
                failed.append({"id": photo_id, "reason": "the photo could not be moved"})
    return {"moved": moved, "failed": failed}


def _move_one_in(live, library, root: Path, photo_id: str) -> dict:
    photo = library.get(photo_id)
    if photo is None:
        raise VaultError("no such photo in the library", status=404)
    source = library.original_path(photo)
    expected = digest(source)
    if not expected.startswith(photo_id):
        raise VaultError("the stored photo does not match its record, so it was left alone", status=409)

    target = copy_verified(source, root / MOVED_IN_FOLDER, photo.get("filename") or source.name, expected)
    try:
        live.seal(expected)
        library.remove_moved(photo_id)
    except Exception:
        # the library still has it: undo the vault copy so nothing is duplicated
        target.unlink(missing_ok=True)
        live.unseal(expected)
        raise
    return {"id": photo_id, "path": target.relative_to(root).as_posix()}


def _forget_in_albums(engine, library):
    """Drops photos the library no longer holds from every album (Favorites
    included), so no album file keeps pointing at a now-private photo."""
    satellite = engine.registry.get(PHOTO_SATELLITE)
    try:
        from satellites.native.photo.albums import albums
    except ImportError:
        return
    if satellite is None:
        return
    store = albums(satellite)
    known = library.all_ids()
    for album in store.all():
        store.prune_missing(album["id"], known)


def move_out(engine, live, root: Path, paths) -> dict:
    """Moves vault files back into the Photo library."""
    library = photo_library(engine)
    if library is None:
        raise VaultError("the Photo satellite is not available", status=503)
    if not isinstance(paths, list) or not paths or not all(isinstance(item, str) for item in paths):
        raise VaultError("'paths' must be a non-empty list of Locked Folder paths")

    moved, failed = [], []
    with _move_lock:
        for relative in dict.fromkeys(paths):
            try:
                moved.append(_move_one_out(live, library, root, relative))
            except VaultError as error:
                failed.append({"path": relative, "reason": str(error)})
            except OSError as error:
                failed.append({"path": relative, "reason": f"the file could not be moved ({error.strerror or error})"})
            except Exception as error:
                print(f"[WARNING]: moving a Locked Folder file into Photos failed ({type(error).__name__}).")
                failed.append({"path": relative, "reason": "the file could not be moved"})
    return {"moved": moved, "failed": failed}


def _move_one_out(live, library, root: Path, relative: str) -> dict:
    source = resolve_item(root, relative)
    expected = digest(source)
    was_sealed = live.is_sealed(expected)
    live.unseal(expected)  # Photo refuses sealed media, and this one is being released on purpose

    added = None
    try:
        added = library.add_file(source, filename=source.name)
        photo = added or library.get_any(expected[:16])
        if photo is None:
            raise VaultError("Photo did not take the file, so it was left in the Locked Folder", status=500)
        if digest(library.original_path(photo)) != expected:
            raise VaultError("the copy in Photos did not match, so the file was left in the Locked Folder", status=500)
        if photo.get("trashed_at"):
            # the same photo was sitting in Photo's recycle bin - bring it back
            # rather than leave the only copy there
            library.restore(photo["id"])
    except Exception as error:
        if added is not None:
            library.remove_moved(added["id"])
        if was_sealed:
            live.seal(expected)
        if isinstance(error, (VaultError, OSError)):
            raise
        raise VaultError(str(error) or "Photo could not read this file") from error

    source.unlink()
    return {"path": relative, "id": photo["id"]}
