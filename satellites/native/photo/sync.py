"""Phone synchronization: a small upload listener owned by the Photo satellite.

The standalone listener below is deliberately separate from Mission Control's
API server: reaching StarCore from a phone on the local network this way
exposes one token-protected upload endpoint instead of the whole Core. It is
still the ingestion path a browser on the phone can be pointed at directly
(SyncHandler's own upload page).

The mobile app's automatic background sync (see "Real automatic phone sync"
in docs/satellites/photo.md) goes through a second, authenticated way to
reach the exact same ingestion logic instead: api.py's `sync_upload` route,
served over the main StarCore API the app already logs into for everything
else - so a phone only ever needs the one server address, and the upload is
covered by whatever HTTPS/Nginx setup already fronts that API, with no
separate port or token to expose. `accept_authenticated_upload()` below is
that second path; it calls the very same `SyncService.accept()` the
standalone listener uses, never a second ingestion implementation.
"""

from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread
from urllib.parse import parse_qs, unquote, urlparse
import json
import secrets
import socket

from .images import UnsupportedImage
from .library import library, storage_root

TOKEN_HEADER = "X-StarCore-Token"
FILENAME_HEADER = "X-Photo-Filename"
TOKEN_FILE = "sync_token"
INCOMING = "incoming"
READ_SIZE = 256 * 1024
HISTORY = 20

_services = {}


def start(engine, satellite):
    """Lifecycle hook: called by the Core once the satellite is loaded."""
    if not satellite.config.get("sync_enabled", True):
        print("Photo sync is disabled.")
        return

    service = SyncService(
        library(satellite),
        satellite.config.get("sync_host", "127.0.0.1"),
        int(satellite.config.get("sync_port", 8081)),
        _token(satellite),
        int(satellite.config.get("sync_max_bytes", 512 * 1024 * 1024)),
    )
    # registered regardless of whether the standalone local-network listener
    # below actually manages to bind a socket: accept() needs nothing from
    # that socket, and this is what the authenticated main-API upload route
    # (api.py's sync_upload, via accept_authenticated_upload() below) goes
    # through - so the mobile app's background sync keeps working even on a
    # machine where the standalone listener's own port can't be bound.
    _services[storage_root(satellite)] = service

    if service.start():
        print(f"Photo sync listening on {service.url}")
    else:
        print("Photo sync's standalone local-network listener could not start; uploads through "
              "the authenticated StarCore API are still accepted.")


def stop(engine, satellite):
    service = _services.pop(storage_root(satellite), None)
    if service is not None:
        service.stop()


def service(satellite):
    return _services.get(storage_root(satellite))


def describe(satellite) -> dict:
    """What Mission Control shows in the Sync section."""
    running = service(satellite)
    if running is None:
        return {
            "enabled": bool(satellite.config.get("sync_enabled", True)),
            "running": False,
            "url": None,
            "token": None,
            "counts": SyncActivity().counts(),
            "events": [],
        }

    return running.describe()


def _token(satellite) -> str:
    configured = str(satellite.config.get("sync_token", "")).strip()
    if configured:
        return configured

    # a token nobody configured still has to survive a restart, otherwise every
    # phone would have to be set up again after each start
    path = storage_root(satellite) / TOKEN_FILE
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()

    token = secrets.token_urlsafe(18)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    return token


class UploadTooLarge(Exception):
    """Raised by accept_authenticated_upload() - mirrors SyncHandler's own
    413 check for the standalone listener below, for the exact same
    sync_max_bytes limit."""


def accept_authenticated_upload(satellite, raw, filename: str) -> dict:
    """The ingestion path api.py's sync_upload route uses: the exact same
    SyncService.accept() the standalone local-network listener below uses
    (never a second implementation), reached instead through the main
    StarCore API - authenticated by the Core's own session mechanism rather
    than this module's own per-phone token, and therefore reachable wherever
    Mission Control itself is, including through whatever HTTPS/Nginx setup
    already fronts it. See "Real automatic phone sync" in
    docs/satellites/photo.md.

    `raw` is a starcore.api.response.RawBody - read here in chunks, exactly
    like SyncHandler._read_body() below, so a large video upload is never
    buffered whole before its size is even known to be within bounds.
    """
    running = service(satellite)
    if running is None:
        raise RuntimeError("photo sync is disabled on this server")

    # recorded here, not by the caller (api.py), so a failure counts toward
    # the same activity/counts the standalone listener's SyncHandler records
    # into for its own failures - Mission Control's Sync section shouldn't
    # have to know there are two upload paths at all
    try:
        if raw.length <= 0:
            raise ValueError("the upload was empty")
        if raw.length > running.max_bytes:
            raise UploadTooLarge(f"the upload is larger than {running.max_bytes} bytes")

        chunks = []
        total = 0
        for chunk in raw:
            total += len(chunk)
            if total > running.max_bytes:
                raise UploadTooLarge(f"the upload is larger than {running.max_bytes} bytes")
            chunks.append(chunk)

        return running.accept(b"".join(chunks), filename)
    except (UploadTooLarge, ValueError, UnsupportedImage) as error:
        running.activity.record(filename, "failed", str(error))
        raise


def local_address() -> str:
    """The address of this machine on the local network, as a phone would reach it."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # a reserved address; nothing is actually sent
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


class SyncActivity:
    def __init__(self):
        self._lock = Lock()
        self._events = deque(maxlen=HISTORY)
        self._counts = {"received": 0, "imported": 0, "duplicates": 0, "failed": 0}

    def record(self, filename: str, status: str, detail: str = None):
        with self._lock:
            self._counts["received"] += 1
            self._counts[{"imported": "imported", "duplicate": "duplicates"}.get(status, "failed")] += 1
            self._events.appendleft({
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "filename": filename,
                "status": status,
                "detail": detail,
            })

    def counts(self) -> dict:
        with self._lock:
            return dict(self._counts)

    def events(self) -> list:
        with self._lock:
            return list(self._events)


class SyncService:
    def __init__(self, photo_library, host: str, port: int, token: str, max_bytes: int):
        self.library = photo_library
        self.host = host
        self.port = port
        self.token = token
        self.max_bytes = max_bytes
        self.activity = SyncActivity()
        self.incoming = photo_library.root / INCOMING
        self._server = None
        self._thread = None

    @property
    def running(self) -> bool:
        return self._server is not None

    @property
    def url(self) -> str:
        host = local_address() if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}"

    def start(self) -> bool:
        try:
            server = ThreadingHTTPServer((self.host, self.port), SyncHandler)
        except (OSError, TypeError, ValueError) as error:
            print(f"[WARNING]: Photo sync could not start on {self.host}:{self.port} ({error}).")
            return False

        server.daemon_threads = True
        server.service = self
        self.port = server.server_address[1]
        self._server = server
        self._thread = Thread(target=server.serve_forever, name="starcore-photo-sync", daemon=True)
        self._thread.start()
        return True

    def stop(self):
        if self._server is None:
            return

        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    def describe(self) -> dict:
        return {
            "enabled": True,
            "running": self.running,
            "url": self.url if self.running else None,
            "token": self.token,
            "counts": self.activity.counts(),
            "events": self.activity.events(),
        }

    def accept(self, data: bytes, filename: str) -> dict:
        """Takes an uploaded image into the library through the normal ingestion path."""
        self.incoming.mkdir(parents=True, exist_ok=True)
        # written aside first: nothing reaches the library until the whole upload
        # is on disk and has been recognised as an image
        partial = self.incoming / f"{secrets.token_hex(8)}.part"

        try:
            partial.write_bytes(data)
            photo = self.library.add_file(partial, filename=filename)
        finally:
            partial.unlink(missing_ok=True)

        if photo is None:
            self.activity.record(filename, "duplicate")
            return {"status": "duplicate", "photo": None}

        self.activity.record(filename, "imported")
        return {"status": "imported", "photo": photo}


class SyncHandler(BaseHTTPRequestHandler):
    server_version = "StarCore"

    def do_GET(self):
        if not self._authorized():
            return

        if urlparse(self.path).path == "/":
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
        else:
            self._error(404, "not found")

    def do_POST(self):
        if not self._authorized():
            return

        if urlparse(self.path).path != "/upload":
            self._error(404, "not found")
            return

        service = self.server.service
        length = self.headers.get("Content-Length")
        filename = safe_filename(self.headers.get(FILENAME_HEADER) or self._query().get("filename"))

        if length is None or not length.isdigit():
            self._failure(filename, 411, "a Content-Length is required")
            return

        length = int(length)
        if length == 0:
            self._failure(filename, 400, "the upload was empty")
            return
        if length > service.max_bytes:
            self._failure(filename, 413, f"the upload is larger than {service.max_bytes} bytes")
            return

        data = self._read_body(length)
        if data is None:
            self._failure(filename, 400, "the upload ended early")
            return

        try:
            result = service.accept(data, filename)
        except UnsupportedImage as error:
            self._failure(filename, 415, str(error))
            return
        except Exception as error:
            # an upload must never drop the connection, whatever arrives
            print(f"[WARNING]: photo sync could not store an upload ({error}).")
            self._failure(filename, 500, "the photo could not be stored")
            return

        self._send_json(200, result)

    def log_message(self, format, *args):
        # the CLI shares this process, so requests stay out of its output
        pass

    def _authorized(self) -> bool:
        token = self.headers.get(TOKEN_HEADER) or self._query().get("token") or ""
        if secrets.compare_digest(token, self.server.service.token):
            return True

        self._error(401, "a valid token is required")
        return False

    def _query(self) -> dict:
        return {key: values[-1] for key, values in parse_qs(urlparse(self.path).query).items()}

    def _read_body(self, length: int):
        chunks = []
        remaining = length

        while remaining > 0:
            chunk = self.rfile.read(min(READ_SIZE, remaining))
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)

        return b"".join(chunks)

    def _failure(self, filename: str, status: int, message: str):
        self.server.service.activity.record(filename, "failed", message)
        self._error(status, message)

    def _error(self, status: int, message: str):
        self._send_json(status, {"status": "error", "error": message})

    def _send_json(self, status: int, payload: dict):
        self._send(status, json.dumps(payload, indent=2).encode("utf-8"), "application/json; charset=utf-8")

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def safe_filename(name) -> str:
    """Only ever used as metadata - the stored name comes from the content digest."""
    if not name:
        return "upload"

    # headers carry only latin-1, so clients percent-encode names with anything else
    cleaned = unquote(str(name)).replace("\\", "/").split("/")[-1]
    cleaned = "".join(character for character in cleaned if character.isprintable()).strip()

    return cleaned[:200] if cleaned and cleaned not in (".", "..") else "upload"


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StarCore Photo Sync</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
    margin: 0; padding: 1.5rem 1.25rem 3rem;
    background: #04060d; color: #e7ecf8;
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; line-height: 1.55;
}
header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.5rem; }
h1 { margin: 0; font-size: 1rem; letter-spacing: 0.02em; }
p.sub { margin: 0; color: #6e7b99; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.16em; }
.card { padding: 1.15rem; border: 1px solid #161d33; border-radius: 8px; background: #0a0f1e; }
label.pick {
    display: block; padding: 1.6rem 1rem; border: 1px dashed #202a47; border-radius: 8px;
    background: linear-gradient(180deg, #0f52ba, #002fa7); color: #fff;
    font-size: 0.95rem; font-weight: 600; text-align: center; cursor: pointer;
}
label.pick input { display: none; }
.muted { color: #98a3be; font-size: 0.85rem; }
ul { margin: 1.25rem 0 0; padding: 0; list-style: none; }
li {
    display: flex; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0;
    border-top: 1px solid #161d33;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem;
}
li span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imported { color: #3ecf8e; }
.duplicate { color: #6c9bf0; }
.failed { color: #e4606d; }
.pending { color: #6e7b99; }
</style>
</head>
<body>
<header>
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#6c9bf0" stroke-width="1.3">
        <circle cx="11" cy="12" r="5"/>
        <ellipse cx="11" cy="12" rx="9.3" ry="3.3" transform="rotate(-22 11 12)" opacity="0.7"/>
    </svg>
    <div><h1>StarCore</h1><p class="sub">Photo sync</p></div>
</header>

<div class="card">
    <label class="pick">Select photos or videos<input id="pick" type="file" accept="image/*,video/*" multiple></label>
    <p class="muted" id="hint">Photos and videos are copied into your StarCore library. Nothing is deleted from this device.</p>
    <ul id="log"></ul>
</div>

<script>
const token = new URLSearchParams(location.search).get("token") || "";
const log = document.getElementById("log");

document.getElementById("pick").addEventListener("change", async (event) => {
    const files = [...event.target.files];
    event.target.value = "";

    for (const file of files) {
        const row = document.createElement("li");
        const name = document.createElement("span");
        const state = document.createElement("span");
        name.textContent = file.name;
        state.textContent = "sending";
        state.className = "pending";
        row.append(name, state);
        log.prepend(row);

        try {
            const response = await fetch(`/upload?token=${encodeURIComponent(token)}`, {
                method: "POST",
                headers: { "X-Photo-Filename": encodeURIComponent(file.name) },
                body: file,
            });
            const payload = await response.json();
            state.textContent = payload.status === "error" ? payload.error : payload.status;
            state.className = payload.status === "error" ? "failed" : payload.status;
        } catch (error) {
            state.textContent = "failed";
            state.className = "failed";
        }
    }
});
</script>
</body>
</html>
"""
