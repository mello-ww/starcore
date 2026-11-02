"""Reading the vault as a media library, uploads and deletes, and verified
moves to and from Photos - for an unencrypted vault and an encrypted one
(see encryption.py) alike.

Listing and serving only ever touch paths that resolve inside the configured
root, so a symlink or ".." can never reach outside it, and never anything
inside .starcore-vault except an encrypted file by its exact name.

Moves never delete anything until the copy on the other side has been
written, flushed to disk and re-read with a matching SHA-256 digest. On any
failure before that point the half-made copy is removed and the original is
left exactly where it was. Once the vault is encrypted, files moved or
uploaded in are only ever written encrypted.
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import os
import secrets
import threading

from . import encryption
from .keys import META_DIR
from .media import MEDIA_TYPES  # noqa: F401 - part of this module's interface

PHOTO_SATELLITE = "Photo"
MOVED_IN_FOLDER = "Photos"     # where photos moved in from the Photo library land
MAX_ITEMS = 20000
READ_SIZE = 1024 * 1024
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

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
    folder = path.relative_to(root).parent.as_posix()
    return {
        "path": path.relative_to(root).as_posix(),
        "name": path.name,
        "folder": "" if folder == "." else folder,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
        "media_type": media_type,
        "content_type": content_type,
        "encrypted": False,
    }


def list_vault(live, root: Path) -> dict:
    """Every file in the vault, newest first: encrypted files (described from
    their encrypted metadata) and any file still stored unencrypted. Raises
    encryption.KeyProblem when the vault is encrypted but can't be opened."""
    store = encryption.Store.open(live, root)
    if store is None:
        return list_items(root)
    hidden_objects, hidden_originals = encryption.in_flight(root)
    items = [item for item in store.items()
             if item["path"] not in hidden_objects and not item["name"].startswith(".")]
    plain = list_items(root)
    items += [item for item in plain["items"] if item["path"] not in hidden_originals]
    items.sort(key=lambda item: item.get("modified") or "", reverse=True)
    truncated = plain["truncated"] or len(items) > MAX_ITEMS
    return {"items": items[:MAX_ITEMS], "truncated": truncated}


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
    """An unencrypted vault file. Nothing inside .starcore-vault is ever
    reachable this way - not the keyring, not a backup, not an encrypted file."""
    if not isinstance(relative, str) or not relative.strip() or "\x00" in relative:
        raise VaultError("'path' must name a file inside the Locked Folder")
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target == root:
        raise VaultError("that path is outside the Locked Folder", status=403)
    if target.relative_to(root).parts[0].lower() == META_DIR:  # Windows names ignore case
        raise VaultError("no such file in the Locked Folder", status=404)
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
    """Moves photos out of the Photo library into the vault's Photos folder -
    encrypted, once the vault is."""
    library = photo_library(engine)
    if library is None:
        raise VaultError("the Photo satellite is not available", status=503)
    if not isinstance(photo_ids, list) or not photo_ids or not all(isinstance(item, str) for item in photo_ids):
        raise VaultError("'photo_ids' must be a non-empty list of photo ids")
    store = encryption.Store.open(live, root)  # KeyProblem: refuse rather than store unencrypted

    moved, failed = [], []
    with _move_lock:
        for photo_id in dict.fromkeys(photo_ids):
            try:
                if store is not None:
                    moved.append(_move_one_in_encrypted(live, library, store, photo_id))
                else:
                    moved.append(_move_one_in(live, library, root, photo_id))
                _forget_in_albums(engine, library)
            except encryption.EncryptionError as error:
                failed.append({"id": photo_id, "reason": str(error)})
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


def _move_one_in_encrypted(live, library, store, photo_id: str) -> dict:
    photo = library.get(photo_id)
    if photo is None:
        raise VaultError("no such photo in the library", status=404)
    source = library.original_path(photo)
    expected = digest(source)
    if not expected.startswith(photo_id):
        raise VaultError("the stored photo does not match its record, so it was left alone", status=409)

    modified = datetime.fromtimestamp(source.stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds")
    relative, _metadata = store.add(encryption.file_chunks(source), {
        "name": _safe_name(photo.get("filename") or source.name), "folder": MOVED_IN_FOLDER, "modified": modified,
    }, expected_sha256=expected)
    try:
        live.seal(expected)
        library.remove_moved(photo_id)
    except Exception:
        store.delete(relative)
        live.unseal(expected)
        raise
    return {"id": photo_id, "path": relative}


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

    store = encryption.Store.open(live, root)

    moved, failed = [], []
    with _move_lock:
        if store is not None:
            # a decrypted copy a crash left behind; no other move is using it now
            store.clear_staging(older_than=encryption.STAGING_GRACE_SECONDS)
        for relative in dict.fromkeys(paths):
            try:
                if encryption.Store.is_object_path(relative):
                    if store is None:
                        raise VaultError("no such file in the Locked Folder", status=404)
                    moved.append(_move_one_out_encrypted(live, library, store, relative))
                else:
                    moved.append(_move_one_out(live, library, root, relative))
            except (VaultError, encryption.EncryptionError) as error:
                failed.append({"path": relative, "reason": str(error)})
            except OSError as error:
                failed.append({"path": relative, "reason": f"the file could not be moved ({error.strerror or error})"})
            except Exception as error:
                print(f"[WARNING]: moving a Locked Folder file into Photos failed ({type(error).__name__}).")
                failed.append({"path": relative, "reason": "the file could not be moved"})
    return {"moved": moved, "failed": failed}


def _move_one_out(live, library, root: Path, relative: str) -> dict:
    source = resolve_item(root, relative)
    photo = _hand_to_photos(live, library, source, source.name, digest(source))
    source.unlink()
    return {"path": relative, "id": photo["id"]}


def _move_one_out_encrypted(live, library, store, relative: str) -> dict:
    # decrypted into the vault's own tmp folder, checked, and removed again
    # whatever happens - never into a shared temp directory
    staging, metadata = store.decrypt_to_staging(relative)
    try:
        photo = _hand_to_photos(live, library, staging, _safe_name(metadata.get("name")), metadata["sha256"])
    finally:
        staging.unlink(missing_ok=True)
    store.delete(relative)
    return {"path": relative, "id": photo["id"]}


def _hand_to_photos(live, library, source: Path, filename: str, expected: str) -> dict:
    """Adds `source` to Photos and checks the copy there. Returns the photo;
    on any failure Photos is left as it was and the vault keeps the file."""
    was_sealed = live.is_sealed(expected)
    live.unseal(expected)  # Photo refuses sealed media, and this one is being released on purpose

    added = None
    try:
        added = library.add_file(source, filename=filename)
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
    return photo


# ---------- uploads and deletes ----------

def _clean_folder(folder) -> str:
    parts = [_safe_name(part) for part in str(folder or "").replace("\\", "/").split("/") if part.strip()]
    if parts and parts[0].lower() == META_DIR:
        raise VaultError("that folder can't be used", status=400)
    return "/".join(parts)


def _body_chunks(raw):
    remaining = raw.length
    while remaining > 0:
        chunk = raw.read(min(READ_SIZE, remaining))
        if not chunk:
            raise VaultError("the upload was cut short, so nothing was saved", status=400)
        remaining -= len(chunk)
        yield chunk


def upload(live, root: Path, raw, name, folder) -> dict:
    """Stores one uploaded file - encrypted, once the vault is. Written aside
    first and only named once complete, so a dropped connection leaves nothing."""
    if raw is None:
        raise VaultError("expected a raw file body, not JSON")
    if raw.length <= 0:
        raise VaultError("the upload was empty")
    if raw.length > MAX_UPLOAD_BYTES:
        raise VaultError(f"the upload is larger than {MAX_UPLOAD_BYTES} bytes", status=413)
    clean_name = _safe_name(name)
    clean_folder = _clean_folder(folder)

    store = encryption.Store.open(live, root)
    if store is not None:
        relative, metadata = store.add(_body_chunks(raw), {
            "name": clean_name, "folder": clean_folder,
            "modified": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        return encryption.describe(relative, metadata)

    directory = (root / clean_folder).resolve() if clean_folder else root
    if not directory.is_relative_to(root):
        raise VaultError("that folder is outside the Locked Folder", status=403)
    directory.mkdir(parents=True, exist_ok=True)
    partial = directory / f".{secrets.token_hex(8)}.part"
    try:
        with open(partial, "xb") as file:
            for chunk in _body_chunks(raw):
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        target = _free_name(directory, clean_name)
        os.rename(partial, target)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return describe(target, root)


def delete(live, root: Path, paths) -> dict:
    """Permanently deletes vault files (never folders)."""
    if not isinstance(paths, list) or not paths or not all(isinstance(item, str) for item in paths):
        raise VaultError("'paths' must be a non-empty list of Locked Folder paths")
    store = encryption.Store.open(live, root)
    deleted, failed = [], []
    for relative in dict.fromkeys(paths):
        try:
            if encryption.Store.is_object_path(relative):
                if store is None:
                    raise VaultError("no such file in the Locked Folder", status=404)
                store.delete(relative)
            else:
                resolve_item(root, relative).unlink()
            deleted.append(relative)
        except (VaultError, encryption.EncryptionError) as error:
            failed.append({"path": relative, "reason": str(error)})
        except OSError as error:
            failed.append({"path": relative, "reason": f"could not be deleted ({error.strerror or type(error).__name__})"})
    return {"deleted": deleted, "failed": failed}
