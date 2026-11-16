"""media.sync v1: a device's one-way backup into the library.

A device hashes its media, asks `check`, and sends only what is wanted, in chunks it can resume
after any cut (docs/satellites/photo.md, "Phone backup"). Each chunk is appended straight to a
partial file on disk, never held whole in memory, and the whole file's SHA-256 must match the
digest it was sent under before the library takes it in, through the same add_file() and
checks as any import.

Known, for `check` and `upload`, means the library has the item, its recycle bin holds it, it
was erased from there (the library remembers erased digests), or it was moved into a protected
store (the Engine's sealed). The answer never says which.

What arrives is kept per caller: the opaque id of the session or device credential that sent
it (AuthStore.caller), never a name the client chooses, so one caller's unfinished uploads never
mix with another's and the limits hold per caller. A caller keeps at most MAX_PARTIALS
unfinished uploads (the oldest goes) for at most PARTIAL_DAYS days.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import threading
import time

from starcore.api.response import error_response, json_response

from . import configuration
from .handover import safe_filename
from .images import UnsupportedImage
from .library import ID_LENGTH, PhotoImportError, library, write_index
from .private_media import policy

ACCEPTS = ["image", "video"]
MAX_BYTES = 16 * 1024 ** 3  # one file
CHUNK_BYTES = 8 * 1024 * 1024  # one request's body, so it fits a proxy's limit
MAX_CHECK = 500
MAX_PARTIALS = 4
PARTIAL_DAYS = 7
SPACE_MARGIN = 256 * 1024 * 1024  # left free on the disk when a new upload starts
READ_SIZE = 1024 * 1024

DIGEST = re.compile(r"^[0-9a-f]{64}$")
CALLER_ID = re.compile(r"^[0-9a-f]{1,64}$")
# what arrives before StarCore has an account, when no session is required
LOCAL = "local"
FOLDER = "backup"

_backups = {}
_creating = threading.Lock()


def route(request):
    """backup/status, backup/check, backup/upload/<sha256>, backup/devices."""
    path = tuple(request.path)
    if path == ("status",):
        return status(request)
    if path == ("check",):
        return check(request)
    if path == ("devices",):
        return devices(request)
    if len(path) == 2 and path[0] == "upload":
        return upload(request, path[1])
    return error_response(f"unknown endpoint 'backup/{'/'.join(path)}'")


# ---------- operations ----------

def status(request):
    """GET ?device= -> {accepts, max_bytes, chunk_bytes, device: {name, last_seen, received}}."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    store = backup(request.satellite)
    store.purge_stale()
    record = store.touch(_caller(request), request.query.get("device"))
    return json_response({
        "accepts": list(ACCEPTS),
        "max_bytes": MAX_BYTES,
        "chunk_bytes": CHUNK_BYTES,
        "device": {key: record.get(key) for key in ("name", "last_seen", "received")},
    })


def check(request):
    """POST {device, items: [{sha256, size}]} -> {known, wanted}; an item larger than
    max_bytes is in neither."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    body = request.body if isinstance(request.body, dict) else {}
    items = body.get("items")
    if not isinstance(items, list):
        return error_response("'items' must be a list of {sha256, size}", status=400)
    if len(items) > MAX_CHECK:
        return error_response(f"at most {MAX_CHECK} items at once", status=400)

    entries = []
    for index, item in enumerate(items):
        digest = item.get("sha256") if isinstance(item, dict) else None
        size = item.get("size") if isinstance(item, dict) else None
        if not isinstance(digest, str) or not DIGEST.match(digest) or not _is_count(size):
            return error_response(f"item {index} must be {{sha256: 64 lowercase hex digits, size: bytes}}",
                                  status=400)
        entries.append((digest, size))

    store = backup(request.satellite)
    known, wanted, seen = [], [], set()
    for digest, size in entries:
        if digest in seen:
            continue
        seen.add(digest)
        if store.known(request.engine, digest):
            known.append(digest)
        elif size <= MAX_BYTES:
            wanted.append(digest)
    store.touch(_caller(request), body.get("device"))
    return json_response({"known": known, "wanted": wanted})


def upload(request, digest: str):
    """GET /<sha256> -> {offset}; POST /<sha256>?offset=&size=&name=&folder=&taken= with the
    bytes from offset -> {offset}, or at the last byte {status, id, offset}."""
    if not DIGEST.match(digest or ""):
        return error_response("name the file by its SHA-256: 64 lowercase hex digits", status=400)
    store = backup(request.satellite)
    caller = _caller(request)
    if request.method == "GET":
        return json_response({"offset": store.offset(caller["id"], digest)})
    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    raw = request.raw
    if raw is None:
        return error_response("send the bytes as an application/octet-stream body", status=415)
    size, offset = _integer(request.query.get("size")), _integer(request.query.get("offset"))
    length = getattr(raw, "length", 0)
    if size is None or size < 1:
        return _refuse(raw, "'size' must be the whole file's size in bytes", 400)
    if size > MAX_BYTES:
        return _refuse(raw, f"this file is larger than {MAX_BYTES} bytes", 413)
    if offset is None or offset < 0:
        return _refuse(raw, "'offset' must be where these bytes start in the file", 400)
    if length < 1:
        return error_response("the body is empty", status=400)
    if length > CHUNK_BYTES:
        return _refuse(raw, f"send at most {CHUNK_BYTES} bytes at once", 413)
    if offset + length > size:
        return _refuse(raw, "these bytes go past the file's size", 400)

    with store.claim(caller["id"], digest) as claimed:
        if not claimed:
            return _refuse(raw, "this file is being sent already", 409,
                           offset=store.offset(caller["id"], digest))
        partial = store.partial(caller["id"], digest, size)
        current = partial.stat().st_size if partial.is_file() else 0
        if offset != current:
            return _refuse(raw, "send from the offset the server holds", 409, offset=current)
        if current == 0:
            if store.known(request.engine, digest):
                _drain(raw)
                return json_response({"status": "duplicate", "id": digest[:ID_LENGTH], "offset": size})
            store.make_room(caller["id"])
            if _free_space(store.root) < size + SPACE_MARGIN:
                return _refuse(raw, "the server does not have enough free space for this file", 507)
            partial.parent.mkdir(parents=True, exist_ok=True)

        held = current + _append(raw, partial, length)
        if held < current + length:
            # what did arrive is kept: the client asks the offset and goes on from there
            return json_response({"error": "the chunk was cut short", "offset": held}, status=400)
        if held < size:
            return json_response({"offset": held})

        if _digest(partial) != digest:
            partial.unlink(missing_ok=True)
            return json_response({"error": "the file does not match its SHA-256; send it again from 0",
                                  "offset": 0}, status=422)
        return store.take_in(request, caller, partial, digest, size)


def devices(request):
    """GET -> {devices: [{name, kind, last_seen, received, current}]}, newest first; refused to a
    device credential, which reads nothing."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    if _caller(request)["kind"] == "device":
        return error_response("a device credential can't list devices", status=403)
    return json_response({"devices": device_list(request)})


def device_list(request) -> list:
    """Who backs up here, newest first, `current` marking the caller of this request."""
    return backup(request.satellite).devices(_caller(request)["id"])


# ---------- the store ----------

def backup(satellite):
    """The backup state of a library (unfinished uploads, what each caller sent), kept per
    storage root like the library itself."""
    photo_library = library(satellite)
    with _creating:
        store = _backups.get(photo_library.root)
        if store is None:
            store = _backups[photo_library.root] = Backup(satellite, photo_library)
    store.satellite = satellite
    return store


class Backup:
    def __init__(self, satellite, photo_library):
        self.satellite = satellite
        self.library = photo_library
        self.root = photo_library.root / FOLDER
        self.partials_dir = self.root / "partials"
        self.devices_path = self.root / "devices.json"
        self._lock = threading.RLock()
        self._busy = set()  # (caller, digest) being written now
        self._devices = self._load_devices()

    # ---------- what is known ----------

    def known(self, engine, digest: str) -> bool:
        return self.library.knows(digest) or policy(engine).is_sealed(digest)

    # ---------- unfinished uploads ----------

    def partial(self, caller_id: str, digest: str, size: int) -> Path:
        """Where this caller's upload of `digest` is held. One under another size is dropped:
        the same digest can't have two sizes, so it was started wrong."""
        folder = self.partials_dir / caller_id
        wanted = folder / f"{digest}-{size}.part"
        for other in folder.glob(f"{digest}-*.part") if folder.is_dir() else ():
            if other != wanted:
                other.unlink(missing_ok=True)
        return wanted

    def offset(self, caller_id: str, digest: str) -> int:
        folder = self.partials_dir / caller_id
        for path in folder.glob(f"{digest}-*.part") if folder.is_dir() else ():
            try:
                return path.stat().st_size
            except OSError:
                return 0
        return 0

    @contextmanager
    def claim(self, caller_id: str, digest: str):
        """Holds (caller, digest) for one request: True when it was free, False when another
        request is writing it now."""
        key = (caller_id, digest)
        with self._lock:
            claimed = key not in self._busy
            if claimed:
                self._busy.add(key)
        try:
            yield claimed
        finally:
            if claimed:
                with self._lock:
                    self._busy.discard(key)

    def make_room(self, caller_id: str):
        """Before a caller starts another upload: stale ones go, then its oldest while it has
        MAX_PARTIALS."""
        self.purge_stale()
        folder = self.partials_dir / caller_id
        if not folder.is_dir():
            return
        with self._lock:
            held = sorted((path for path in folder.glob("*.part") if not self._is_busy(caller_id, path)),
                          key=_modified)
            while len(held) >= MAX_PARTIALS:
                held.pop(0).unlink(missing_ok=True)

    def purge_stale(self):
        """Drops every unfinished upload untouched for PARTIAL_DAYS days."""
        if not self.partials_dir.is_dir():
            return
        cutoff = time.time() - PARTIAL_DAYS * 86400
        with self._lock:
            for folder in self.partials_dir.iterdir():
                if not folder.is_dir():
                    continue
                for path in folder.glob("*.part"):
                    if _modified(path) < cutoff and not self._is_busy(folder.name, path):
                        path.unlink(missing_ok=True)
                try:
                    folder.rmdir()  # only when empty
                except OSError:
                    pass

    def _is_busy(self, caller_id: str, path: Path) -> bool:
        return (caller_id, path.name.split("-", 1)[0]) in self._busy

    # ---------- taking a file in ----------

    def take_in(self, request, caller: dict, partial: Path, digest: str, size: int):
        """The whole file arrived and matches its digest: into the library, as an import."""
        try:
            if self.known(request.engine, digest):
                return json_response({"status": "duplicate", "id": digest[:ID_LENGTH], "offset": size})
            query = request.query
            taken = _taken(query.get("taken"))
            if taken is not None:
                os.utime(partial, (taken, taken))
            try:
                added = self.library.add_file(
                    partial, filename=safe_filename(query.get("name")),
                    physical_path=configuration.resolve_physical_path(self.satellite, query.get("folder")),
                    private=policy(request.engine),
                    captured_at=None if taken is None else datetime.fromtimestamp(taken).isoformat(timespec="seconds"))
            except UnsupportedImage as error:
                return json_response({"error": str(error), "offset": 0}, status=415)
            except PhotoImportError as error:
                return json_response({"error": str(error), "offset": 0}, status=400)
        finally:
            partial.unlink(missing_ok=True)

        if added is not None:
            self.touch(caller, None, received=1)
        return json_response({"status": "imported" if added else "duplicate", "id": digest[:ID_LENGTH],
                              "offset": size})

    # ---------- devices ----------

    def touch(self, caller: dict, name, received: int = 0) -> dict:
        """Records that a caller was seen (and named itself `name`, or what it signed in as):
        its record, as saved."""
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._lock:
            record = self._devices.setdefault(caller["id"], {"name": None, "kind": caller["kind"],
                                                             "first_seen": now, "received": 0})
            record["name"] = _device_name(name) or record.get("name") or _device_name(caller.get("name"))
            record["kind"] = caller["kind"]
            record["last_seen"] = now
            record["received"] = int(record.get("received") or 0) + received
            write_index(self.devices_path, {"version": 1, "devices": self._devices})
            return dict(record)

    def devices(self, current_id: str) -> list:
        with self._lock:
            listed = [{"name": record.get("name"), "kind": record.get("kind"),
                       "last_seen": record.get("last_seen"), "received": record.get("received", 0),
                       "current": caller_id == current_id}
                      for caller_id, record in self._devices.items()]
        return sorted(listed, key=lambda entry: entry["last_seen"] or "", reverse=True)

    def _load_devices(self) -> dict:
        try:
            data = json.loads(self.devices_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            print(f"[WARNING]: the backup's device list could not be read ({error}). Starting empty.")
            return {}
        found = data.get("devices") if isinstance(data, dict) else None
        return {key: value for key, value in found.items() if isinstance(value, dict)} \
            if isinstance(found, dict) else {}


# ---------- helpers ----------

def _caller(request) -> dict:
    """{id, kind, name} of who sent this request: its session or device credential, or LOCAL
    when no session was needed (before StarCore has an account)."""
    auth = getattr(request.engine, "auth", None)
    who = auth.caller(request.token) if auth is not None and request.token else None
    if who is None or not isinstance(who.get("id"), str) or not CALLER_ID.match(who["id"]):
        return {"id": LOCAL, "kind": LOCAL, "name": None}
    return who


def _device_name(value):
    if not isinstance(value, str):
        return None
    cleaned = "".join(character for character in value if character.isprintable()).strip()
    return cleaned[:80] or None


def _is_count(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _integer(value):
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _taken(value):
    """When the media was taken, as seconds since the epoch, or None."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if 0 < seconds < 1e11 else None


def _append(raw, partial: Path, length: int) -> int:
    """Appends up to `length` bytes of the body to `partial`, a piece at a time: what was
    written (less when the body was cut short, and what did arrive is kept)."""
    written = 0
    with open(partial, "ab") as out:
        while written < length:
            chunk = raw.read(min(READ_SIZE, length - written))
            if not chunk:
                break
            out.write(chunk)
            written += len(chunk)
        out.flush()
        os.fsync(out.fileno())
    return written


def _drain(raw):
    """Reads a refused chunk's body (at most CHUNK_BYTES), so the client gets the answer rather
    than a connection closed while it was still sending."""
    remaining = min(getattr(raw, "length", 0), CHUNK_BYTES)
    while remaining > 0:
        chunk = raw.read(min(READ_SIZE, remaining))
        if not chunk:
            return
        remaining -= len(chunk)


def _refuse(raw, message: str, status: int, offset: int = None):
    _drain(raw)
    payload = {"error": message}
    if offset is not None:
        payload["offset"] = offset
    return json_response(payload, status=status)


def _free_space(path: Path) -> int:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return 0


def _modified(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(READ_SIZE), b""):
            hasher.update(chunk)
    return hasher.hexdigest()
