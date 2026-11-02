"""The encrypted vault: its file store, the explicit migration from an
unencrypted vault, the backups that migration keeps, and the recovery key.

Layout inside the vault folder once encryption is on:

    .starcore-vault/keyring.json        the wrapped vault key (keys.py)
    .starcore-vault/objects/<id>.sclf   one encrypted file each (crypto.py) -
                                        names, folders and dates are inside
    .starcore-vault/runs/<run>.json     the journal of each encryption run
    .starcore-vault/backups/<run>/...   the originals that run encrypted,
                                        kept until the owner deletes them
    .starcore-vault/tmp/                decrypted copies on their way to
                                        Photos; emptied before each move out

Migration never deletes anything. Each original is encrypted to a temporary
file, flushed to disk, decrypted again and checked against its SHA-256, and
only then given its final name. Only when every file of the run has passed is
any original moved - by a rename, into the run's backup folder - and the
backup stays until the owner deletes it. The journal is written before each
step, so an interrupted run resumes (or is undone) from where it stopped.
"""

from datetime import datetime, timezone
from pathlib import Path
import errno
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time

from . import crypto, keystore, media
from .keys import META_DIR, OBJECT_SUFFIX, OBJECTS, KeyProblem, Keyring, is_encrypted  # noqa: F401 - re-exported

RUNS = "runs"
BACKUPS = "backups"
TMP = "tmp"
STAGING_GRACE_SECONDS = 600  # a decrypted copy younger than this may still be in use
READ_SIZE = 1024 * 1024
SPACE_MARGIN = 64 * 1024 * 1024     # free space kept on top of what a run needs
MAX_ITEMS = 20000

_OBJECT_PATH = re.compile(r"^\.starcore-vault/objects/([0-9a-f]{32})\.sclf$")

# vault keys already opened with the server key, by (root, keyring and key
# file versions) - opening one means a DPAPI call, not worth doing per request
_open_keys = {}
_open_keys_lock = threading.Lock()


class EncryptionError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stamp(path: Path):
    try:
        status = path.stat()
        return status.st_mtime_ns, status.st_size
    except OSError:
        return None


def forget_keys():
    with _open_keys_lock:
        _open_keys.clear()


# ---------- the vault key ----------

def vault_key(live, root=None):
    """(vault key, vault id) for the configured vault, None when it isn't
    encrypted. Raises KeyProblem when it is but can't be opened."""
    root = Path(root) if root is not None else live.configured_root
    if root is None or not is_encrypted(root):
        return None
    if not crypto.available():
        raise KeyProblem("encryption_unavailable",
                         "this vault is encrypted, but StarCore's encryption support isn't installed")
    cache_key = (str(root), _stamp(root / META_DIR / "keyring.json"), _stamp(keystore.key_path(live.storage_root)))
    with _open_keys_lock:
        if cache_key in _open_keys:
            return _open_keys[cache_key]

    keyring = Keyring.load(root, live.storage_root)
    if keyring is None:
        return None
    try:
        server_key = keystore.load(live.storage_root)
        opened = keyring.open_with_server(server_key), keyring.vault_id
    except keystore.KeyUnavailable as error:
        raise KeyProblem("key_unavailable", str(error)) from None
    except crypto.WrongKey:
        raise KeyProblem("key_unavailable", "this server's key doesn't open this vault") from None
    except crypto.CorruptFile:
        raise KeyProblem("keyring_damaged", "the vault's keyring is damaged") from None
    with _open_keys_lock:
        _open_keys.clear()  # only ever the current version of one vault
        _open_keys[(str(root), _stamp(root / META_DIR / "keyring.json"),
                    _stamp(keystore.key_path(live.storage_root)))] = opened
    return opened


def binder(live):
    opened = vault_key(live)
    if opened is None:
        return None
    return _binder(*opened)


def _binder(key: bytes, vault_id: bytes):
    return lambda label, payload: crypto.binding(key, vault_id, label, payload)


# ---------- the store ----------

class Store:
    """The encrypted files of one vault."""

    def __init__(self, root: Path, key: bytes, vault_id: bytes):
        self.root = Path(root)
        self.key = key
        self.vault_id = vault_id
        self.meta = self.root / META_DIR
        self.objects = self.meta / OBJECTS
        self.tmp = self.meta / TMP

    @classmethod
    def open(cls, live, root=None):
        opened = vault_key(live, root)
        if opened is None:
            return None
        return cls(Path(root) if root is not None else live.configured_root, *opened)

    @staticmethod
    def is_object_path(relative) -> bool:
        return isinstance(relative, str) and _OBJECT_PATH.match(relative) is not None

    def object_path(self, relative) -> Path:
        if not self.is_object_path(relative):
            raise EncryptionError("no such file in the Locked Folder", status=404)
        path = self.objects / f"{_OBJECT_PATH.match(relative).group(1)}{OBJECT_SUFFIX}"
        if not path.is_file():
            raise EncryptionError("no such file in the Locked Folder", status=404)
        return path

    @staticmethod
    def relative(path: Path) -> str:
        return f"{META_DIR}/{OBJECTS}/{path.name}"

    def open_file(self, relative) -> crypto.EncryptedFile:
        try:
            return crypto.EncryptedFile(self.object_path(relative), self.key, self.vault_id)
        except crypto.CorruptFile as error:
            raise EncryptionError(f"this file can't be opened: {error}", status=422) from None

    def items(self) -> list:
        """Every encrypted file, described from its encrypted metadata. A file
        that fails to authenticate is listed as damaged, never skipped."""
        items = []
        try:
            entries = sorted(os.scandir(self.objects), key=lambda entry: entry.name)
        except FileNotFoundError:
            return items
        for entry in entries:
            if not entry.name.endswith(OBJECT_SUFFIX) or not entry.is_file(follow_symlinks=False):
                continue
            relative = self.relative(Path(entry.path))
            try:
                with crypto.EncryptedFile(entry.path, self.key, self.vault_id) as opened:
                    items.append(describe(relative, opened.metadata))
            except (crypto.CorruptFile, OSError):
                items.append({"path": relative, "name": "Damaged file", "folder": "", "size": entry.stat().st_size,
                              "modified": None, "media_type": "file", "content_type": "application/octet-stream",
                              "encrypted": True, "damaged": True})
            if len(items) >= MAX_ITEMS:
                break
        return items

    def add(self, chunks, metadata: dict, expected_sha256: str = None):
        """Encrypts `chunks` into a new file: written aside, flushed, decrypted
        again and checked, and only then given its name. Returns
        (relative path, metadata). Nothing is left behind on failure."""
        self.objects.mkdir(parents=True, exist_ok=True)
        object_id = secrets.token_hex(16)
        partial = self.objects / f".{object_id}.part"
        final = self.objects / f"{object_id}{OBJECT_SUFFIX}"
        try:
            with open(partial, "xb") as out:
                writer = crypto.Encryptor(out, self.key, self.vault_id)
                for chunk in chunks:
                    writer.write(chunk)
                complete = writer.finish(metadata)
                out.flush()
                os.fsync(out.fileno())
            if expected_sha256 is not None and complete["sha256"] != expected_sha256:
                raise EncryptionError("the file changed while it was being encrypted", status=409)
            with crypto.EncryptedFile(partial, self.key, self.vault_id) as check:
                if check.verify() != complete["sha256"]:
                    raise EncryptionError("the encrypted copy did not verify", status=500)
            os.rename(partial, final)
            return self.relative(final), complete
        except crypto.CorruptFile:
            partial.unlink(missing_ok=True)
            raise EncryptionError("the encrypted copy did not verify", status=500) from None
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        finally:
            # a source generator stopped halfway would keep its file open -
            # on Windows that blocks moving the original until it's collected
            close = getattr(chunks, "close", None)
            if close is not None:
                close()

    def verify(self, relative, expected_sha256: str = None) -> bool:
        try:
            with self.open_file(relative) as opened:
                digest = opened.verify()
        except (EncryptionError, crypto.CorruptFile, OSError):
            return False
        return expected_sha256 is None or digest == expected_sha256

    def delete(self, relative):
        self.object_path(relative).unlink()

    def decrypt_to_staging(self, relative):
        """Decrypts one file into the vault's own tmp folder (never a shared
        temp directory), checked against its SHA-256. Returns (path, metadata);
        the caller removes the file."""
        self.tmp.mkdir(parents=True, exist_ok=True)
        staging = self.tmp / f"{secrets.token_hex(8)}.part"
        try:
            with self.open_file(relative) as opened, open(staging, "xb") as out:
                hasher = hashlib.sha256()
                for chunk in opened.chunks():
                    hasher.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
                if hasher.hexdigest() != opened.metadata.get("sha256"):
                    raise EncryptionError("this file's contents don't match its checksum", status=422)
                return staging, opened.metadata
        except crypto.CorruptFile as error:
            staging.unlink(missing_ok=True)
            raise EncryptionError(f"this file can't be opened: {error}", status=422) from None
        except BaseException:
            staging.unlink(missing_ok=True)
            raise

    def clear_staging(self, older_than: float = 0.0):
        """Removes decrypted copies a crash or kill left behind. `older_than`
        (seconds) spares copies still being used by a live operation."""
        if self.tmp.is_dir():
            cutoff = time.time() - older_than
            for leftover in self.tmp.iterdir():
                try:
                    if older_than and leftover.stat().st_mtime > cutoff:
                        continue
                    leftover.unlink()
                except OSError:
                    pass


def describe(relative: str, metadata: dict) -> dict:
    name = str(metadata.get("name") or "file")
    media_type, content_type = media.kind(name)
    return {
        "path": relative,
        "name": name,
        "folder": str(metadata.get("folder") or ""),
        "size": metadata.get("size"),
        "modified": metadata.get("modified"),
        "media_type": media_type,
        "content_type": content_type,
        "encrypted": True,
    }


def file_chunks(path: Path):
    with open(path, "rb") as source:
        while chunk := source.read(READ_SIZE):
            yield chunk


# ---------- plaintext files still in the vault folder ----------

def plaintext_files(root: Path) -> list:
    """Relative paths (posix) of every regular file in the vault folder that
    isn't encrypted yet - everything outside .starcore-vault except
    in-progress *.part copies. Symlinks are never followed."""
    root = Path(root)
    found = []
    for directory, folders, files in os.walk(root, followlinks=False):
        here = Path(directory)
        if here == root:
            folders[:] = [name for name in folders if name != META_DIR]
        folders.sort()
        for name in sorted(files):
            if name.endswith(".part"):
                continue
            path = here / name
            if path.is_symlink() or not path.is_file():
                continue
            found.append(path.relative_to(root).as_posix())
    return found


# ---------- encryption runs (the migration) ----------

def _runs_dir(root: Path) -> Path:
    return Path(root) / META_DIR / RUNS


def _save_run(root: Path, run: dict):
    directory = _runs_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{run['id']}.json"
    partial = directory / f".{run['id']}.{secrets.token_hex(4)}.part"
    try:
        with open(partial, "w", encoding="utf-8") as file:
            json.dump(run, file, indent=1)
            file.flush()
            os.fsync(file.fileno())
        os.replace(partial, path)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def runs(root: Path) -> list:
    """Every run journal, oldest first. One that can't be read is reported,
    never guessed at."""
    found = []
    directory = _runs_dir(root)
    if not directory.is_dir():
        return found
    for path in sorted(directory.glob("*.json")):
        try:
            run = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(run, dict) and isinstance(run.get("files"), dict):
                found.append(run)
                continue
        except (OSError, ValueError):
            pass
        found.append({"id": path.stem, "phase": "damaged", "files": {}})
    return found


def unfinished_run(root: Path):
    for run in runs(root):
        if run.get("phase") in ("encrypting", "backing-up"):
            return run
    return None


def in_flight(root: Path):
    """(encrypted copies to hide, originals to hide) while a run is
    unfinished, so the listing never shows a file twice: while encrypting,
    the originals are what counts; once they're being moved to the backup,
    the encrypted copies are."""
    run = unfinished_run(root)
    if run is None:
        return set(), set()
    if run.get("phase") == "encrypting":
        return {entry.get("object") for entry in run["files"].values()}, set()
    return set(), set(run["files"])


class Progress:
    """What Mission Control shows while a run is going."""

    def __init__(self):
        self.running = False
        self.done = 0
        self.total = 0
        self.failed = []
        self.error = None
        self.run_id = None

    def as_dict(self) -> dict:
        return {"running": self.running, "done": self.done, "total": self.total,
                "failed": self.failed[:50], "error": self.error, "run": self.run_id}


def encrypt_vault(live, root: Path, progress: Progress = None) -> dict:
    """Encrypts every plaintext file in the vault folder - resuming an
    unfinished run if there is one. Synchronous; the API runs it in a thread.

    Returns {"run", "encrypted", "failed", "phase"}. Originals are moved into
    the run's backup folder only when every file of the run verified."""
    progress = progress or Progress()
    root = Path(root)
    store = Store.open(live, root)
    if store is None:
        raise EncryptionError("set up encryption first", status=409)

    run = unfinished_run(root)
    if run is None:
        run = {"id": time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + secrets.token_hex(3),
               "phase": "encrypting", "created": _now(), "files": {}}
    progress.run_id = run["id"]

    if run["phase"] == "encrypting":
        pending = [relative for relative in plaintext_files(root) if relative not in run["files"]]
        needed = sum(_size(root / relative) for relative in pending)
        free = shutil.disk_usage(root).free
        if free < needed + SPACE_MARGIN:
            raise EncryptionError(
                f"not enough free space: encrypting needs about {_mib(needed + SPACE_MARGIN)} MiB "
                f"and {_mib(free)} MiB is free. Nothing was changed.", status=507)
        _save_run(root, run)

        progress.total = len(pending) + len(run["files"])
        progress.done = len(run["files"])
        # files a crash left half-recorded are checked again, not trusted
        for relative, entry in list(run["files"].items()):
            if not store.verify(entry.get("object"), entry.get("sha256")):
                del run["files"][relative]
                pending.append(relative)
                progress.done -= 1
        _save_run(root, run)

        failed = []
        for relative in pending:
            try:
                entry = _encrypt_one(store, root, relative)
            except OSError as error:
                if error.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)):
                    run["failed"] = failed + [{"path": relative, "reason": "the disk is full"}]
                    _save_run(root, run)
                    raise EncryptionError("the disk filled up - encryption stopped. Every original is "
                                          "still in place; free some space and resume.", status=507) from None
                failed.append({"path": relative, "reason": f"could not be read ({error.strerror or type(error).__name__})"})
                continue
            except EncryptionError as error:
                failed.append({"path": relative, "reason": str(error)})
                continue
            if entry is None:
                continue  # vanished meanwhile
            run["files"][relative] = entry
            _save_run(root, run)
            progress.done += 1
        progress.failed = failed
        if failed:
            run["failed"] = failed
            _save_run(root, run)
            return {"run": run["id"], "phase": run["phase"], "encrypted": len(run["files"]), "failed": failed}

        run["phase"] = "backing-up"
        run.pop("failed", None)
        _save_run(root, run)

    _move_originals_to_backup(root, run)
    run["phase"] = "done"
    run["finished"] = _now()
    _save_run(root, run)
    return {"run": run["id"], "phase": "done", "encrypted": len(run["files"]), "failed": []}


def _encrypt_one(store: Store, root: Path, relative: str):
    source = root / relative
    before = _stamp(source)
    if before is None:
        return None
    modified = datetime.fromtimestamp(before[0] / 1e9, tz=timezone.utc).isoformat(timespec="seconds")
    folder = Path(relative).parent.as_posix()
    object_path, complete = store.add(file_chunks(source), {
        "name": Path(relative).name, "folder": "" if folder == "." else folder, "modified": modified,
    })
    if _stamp(source) != before:
        store.delete(object_path)
        raise EncryptionError("the file changed while it was being encrypted - try again")
    return {"object": object_path, "sha256": complete["sha256"], "size": complete["size"],
            "mtime_ns": before[0]}


def _move_originals_to_backup(root: Path, run: dict):
    backup = root / META_DIR / BACKUPS / run["id"]
    for relative, entry in run["files"].items():
        source = root / relative
        target = backup / relative
        if not source.exists():
            continue  # moved already by an earlier, interrupted attempt
        if _stamp(source) != (entry.get("mtime_ns"), entry.get("size")):
            # changed after it was encrypted: keep the newer original in place
            # (it is encrypted on the next run) and drop the stale copy
            entry["stale"] = True
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise EncryptionError(f"the backup already holds {relative} - nothing more was moved", status=409)
        os.rename(source, target)
    for relative, entry in list(run["files"].items()):
        if entry.pop("stale", False):
            try:
                _object_path_unchecked(root, entry["object"]).unlink(missing_ok=True)
            except (OSError, KeyError):
                pass
            del run["files"][relative]
    _remove_empty_folders(root)


def _remove_empty_folders(root: Path):
    for directory, folders, _files in os.walk(root, topdown=False, followlinks=False):
        here = Path(directory)
        if here == root or META_DIR in here.relative_to(root).parts:
            continue
        try:
            here.rmdir()
        except OSError:
            pass  # not empty


def _object_path_unchecked(root: Path, relative: str) -> Path:
    match = _OBJECT_PATH.match(relative or "")
    if match is None:
        raise KeyError(relative)
    return Path(root) / META_DIR / OBJECTS / f"{match.group(1)}{OBJECT_SUFFIX}"


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _mib(value: int) -> int:
    return -(-value // (1024 * 1024))


def backups(root: Path) -> list:
    """Backups still on disk, one per finished run."""
    found = []
    for run in runs(root):
        folder = Path(root) / META_DIR / BACKUPS / str(run.get("id"))
        if run.get("phase") == "done" and folder.is_dir():
            files = [path for path in folder.rglob("*") if path.is_file()]
            found.append({"id": run["id"], "created": run.get("finished") or run.get("created"),
                          "files": len(files), "bytes": sum(_size(path) for path in files)})
    return found


def undo_run(live, root: Path, run_id: str) -> dict:
    """Puts a run's originals back where they were and removes its encrypted
    copies - for a run that was interrupted, or a finished one whose backup
    is still there. Files whose encrypted copy is gone (deleted or moved to
    Photos since) stay in the backup rather than coming back."""
    root = Path(root)
    run = next((item for item in runs(root) if item.get("id") == run_id), None)
    if run is None or run.get("phase") == "damaged":
        raise EncryptionError("no such encryption run", status=404)
    backup = root / META_DIR / BACKUPS / run["id"]
    restored, kept = 0, []
    for relative, entry in run["files"].items():
        source = root / relative
        saved = backup / relative
        try:
            object_path = _object_path_unchecked(root, entry.get("object"))
        except KeyError:
            object_path = None
        if saved.exists():
            if object_path is None or not object_path.exists():
                kept.append(relative)
                continue
            if source.exists():
                kept.append(relative)  # something new took its place
                continue
            source.parent.mkdir(parents=True, exist_ok=True)
            os.rename(saved, source)
        if object_path is not None:
            object_path.unlink(missing_ok=True)
        restored += 1
    if kept:
        run["files"] = {relative: run["files"][relative] for relative in kept}
        run["phase"] = "done"
        _save_run(root, run)
    else:
        (_runs_dir(root) / f"{run['id']}.json").unlink(missing_ok=True)
        _remove_tree_if_empty(backup)
    _drop_keyring_if_unused(live, root)
    return {"restored": restored, "kept_in_backup": kept}


def discard_backup(live, root: Path, run_id: str) -> dict:
    """Deletes a finished run's backup of originals - only after every file
    of that run that is still in the vault decrypts and matches again."""
    root = Path(root)
    run = next((item for item in runs(root) if item.get("id") == run_id), None)
    if run is None or run.get("phase") != "done":
        raise EncryptionError("no such finished encryption run", status=404)
    store = Store.open(live, root)
    if store is None:
        raise EncryptionError("this vault isn't encrypted", status=409)
    for relative, entry in run["files"].items():
        object_path = entry.get("object")
        try:
            present = _object_path_unchecked(root, object_path).exists()
        except KeyError:
            present = False
        if present and not store.verify(object_path, entry.get("sha256")):
            raise EncryptionError(f"the encrypted copy of {relative} did not verify, so the backup was kept",
                                  status=409)
    backup = root / META_DIR / BACKUPS / run["id"]
    if backup.is_dir():
        shutil.rmtree(backup)
    run["backup_deleted"] = _now()
    _save_run(root, run)
    return {"deleted": run["id"]}


def _remove_tree_if_empty(path: Path):
    if not path.is_dir():
        return
    for directory, _folders, _files in os.walk(path, topdown=False):
        try:
            Path(directory).rmdir()
        except OSError:
            pass


def _drop_keyring_if_unused(live, root: Path):
    """After every encrypted file was undone, the vault is simply unencrypted
    again: keyring and bookkeeping go, the originals are back."""
    if keys_has_anything(root):
        return
    keyring = None
    try:
        keyring = Keyring.load(root, live.storage_root)
    except KeyProblem:
        pass
    if keyring is not None:
        keyring.delete()
    meta = root / META_DIR
    for name in (TMP, RUNS, BACKUPS, OBJECTS):
        _remove_tree_if_empty(meta / name)
    try:
        meta.rmdir()
    except OSError:
        pass
    forget_keys()


def keys_has_anything(root: Path) -> bool:
    from .keys import has_objects
    return has_objects(root) or bool(runs(root)) or bool(backups(root))


# ---------- setting encryption up ----------

def set_up(live, root: Path, with_recovery: bool):
    """Creates the vault key for an unencrypted vault. The PIN record and
    device list are bound to it first, so a crash at any point leaves either
    the old, unencrypted vault or a complete keyring - never a keyring the
    PIN doesn't match. Returns the recovery key text, or None."""
    if not crypto.available():
        raise EncryptionError("StarCore's encryption support isn't installed on this server "
                              "(install the engine's 'encryption' extra)", status=501)
    root = Path(root)
    if is_encrypted(root):
        raise EncryptionError("this vault is already encrypted", status=409)
    try:
        server_key = keystore.load(live.storage_root, create=True)
    except keystore.KeyUnavailable as error:
        raise EncryptionError(f"the server key can't be used: {error}", status=500) from None
    keyring, key = Keyring.create(root, live.storage_root, server_key)
    recovery = keyring.set_recovery(key) if with_recovery else None
    live.bind_existing(_binder(key, keyring.vault_id))
    keyring.save()
    forget_keys()
    return recovery


# ---------- the recovery key ----------

def recover(live, root: Path, recovery_text: str, new_pin: str, token: str, limits) -> None:
    """Resets the PIN with the recovery key - and, on a server whose own key
    doesn't open this vault (a new machine, a lost key), re-wraps the vault
    key for this server. Rate-limited like the PIN, on a counter of its own.
    Raises EncryptionError; crypto.WrongKey for a wrong key."""
    root = Path(root)
    try:
        secret = crypto.parse_recovery_key(recovery_text)
    except ValueError:
        raise EncryptionError("that isn't a recovery key - check it and try again", status=400) from None
    if not crypto.available():
        raise EncryptionError("StarCore's encryption support isn't installed on this server", status=501)
    keyring = Keyring.load(root, live.storage_root)  # raises KeyProblem
    if keyring is None or not keyring.has_recovery:
        raise EncryptionError("this Locked Folder has no recovery key", status=400)

    max_attempts, lockout_seconds = limits
    wait = live.begin_attempt(token, max_attempts, lockout_seconds, kind="recovery")
    if wait:
        return wait
    try:
        key = keyring.open_with_recovery(secret)
    except crypto.CorruptFile:
        raise EncryptionError("the recovery slot is damaged", status=409) from None
    # crypto.WrongKey propagates: a wrong key, already counted

    server_key = _server_key_for_recovery(live)
    try:
        opened = keyring.open_with_server(server_key)
        needs_rewrap = opened != key
    except (crypto.WrongKey, crypto.CorruptFile):
        needs_rewrap = True
    if needs_rewrap:
        keyring.set_server(key, server_key)
        keyring.save()
    forget_keys()
    live.set_pin(new_pin, bind=_binder(key, keyring.vault_id))
    live.record_success(token, kind="recovery")
    return 0


def _server_key_for_recovery(live) -> bytes:
    """This server's key - a fresh one when the old file can't be opened any
    more (another Windows account, damage). The old file is kept aside."""
    try:
        return keystore.load(live.storage_root, create=True)
    except keystore.KeyUnavailable:
        path = keystore.key_path(live.storage_root)
        aside = path.with_name(f"{path.name}.unreadable-{time.strftime('%Y%m%d-%H%M%S')}")
        os.replace(path, aside)
        print(f"[WARNING]: the Locked Folder server key could not be opened; kept it as {aside.name} "
              f"and created a new one after a successful recovery.")
        return keystore.load(live.storage_root, create=True)


def replace_recovery_key(live, root: Path, remove: bool = False):
    """A new recovery key (returned once), or none at all."""
    root = Path(root)
    opened = vault_key(live, root)
    if opened is None:
        raise EncryptionError("this vault isn't encrypted", status=409)
    keyring = Keyring.load(root, live.storage_root)
    if remove:
        keyring.remove_recovery()
        text = None
    else:
        text = keyring.set_recovery(opened[0])
    keyring.save()
    forget_keys()
    return text


# ---------- what Mission Control and the phone are told ----------

def status(live, root, unlocked: bool) -> dict:
    root = Path(root) if root is not None else None
    progress = live.migration.as_dict() if live.migration is not None else None
    result = {
        "available": crypto.available(),
        "state": "off",
        "problem": None,
        "recovery_key": False,
        "migration": progress,
    }
    if root is None or not is_encrypted(root):
        if unlocked and root is not None and root.is_dir():
            result["unencrypted_files"] = len(plaintext_files(root))
        return result

    try:
        keyring = Keyring.load(root, live.storage_root)
        result["recovery_key"] = bool(keyring and keyring.has_recovery)
        vault_key(live, root)
    except KeyProblem as problem:
        result["problem"] = problem.code

    running = progress is not None and progress["running"]
    unfinished = unfinished_run(root)
    if running:
        result["state"] = "encrypting"
    elif unfinished is not None:
        result["state"] = "interrupted"
        result["interrupted_run"] = unfinished["id"]
    else:
        result["state"] = "on"
    if unlocked and result["problem"] is None:
        result["unencrypted_files"] = len(plaintext_files(root))
        result["backups"] = backups(root)
    return result
