from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread, Timer
from urllib.parse import parse_qs, quote, unquote, urlparse
import json
import ssl

from . import payloads
from .response import RawBody, Request, Response
from ..auth import AuthError, AuthStore, SESSION_COOKIE, SESSION_TTL_SECONDS
from ..core import SatelliteError
from ..engine_config import ConfigurationError

SATELLITE_PREFIX = "/api/satellites/"
AUTH_PREFIX = "/api/auth/"
# the only /api/auth/* endpoints reachable with no session at all - everything
# else under /api/auth/ (notably /api/auth/sessions and its /revoke) is just
# as protected as any other satellite route once an administrator exists
AUTH_OPEN_ENDPOINTS = {"/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"}
WRITE_ENDPOINTS = ("/api/commands/execute", "/api/shutdown", "/api/restart",
                   "/api/auth/setup", "/api/auth/login", "/api/auth/logout", "/api/auth/sessions/revoke")

# reserved below a satellite, so a satellite cannot claim any of these as a
# route name of its own - "assets" is the satellite's Mission Control files,
# the other three are the Core's generic lifecycle controls (see
# docs/satellites.md); every satellite gets them for free, so none of them
# can be shadowed
ASSETS_SEGMENT = "assets"
LIFECYCLE_ACTIONS = {"enable": True, "disable": False}
RELOAD_SEGMENT = "reload"

FILE_CHUNK = 64 * 1024

CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


def _content_disposition(filename: str) -> str:
    """A Content-Disposition: attachment header for an arbitrary filename.

    filename= carries an ASCII-safe fallback (anything else replaced with
    '_') and filename*= carries the exact name percent-encoded per RFC 5987,
    so a non-ASCII name (e.g. accented characters) still downloads correctly
    in the browsers that use it, while older clients fall back cleanly.
    """
    ascii_fallback = filename.encode("ascii", "replace").decode("ascii").replace('"', "_")
    encoded = quote(filename, safe="")
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'


class ApiServer:
    def __init__(self, engine, host: str, port: int, web_root: Path,
                 https_enabled: bool = False, https_cert: Path = None, https_key: Path = None):
        self.engine = engine
        self.host = host
        self.port = port
        self.web_root = web_root
        self.https_enabled = https_enabled
        self.https_cert = https_cert
        self.https_key = https_key
        self._server = None
        self._thread = None

    @property
    def running(self) -> bool:
        return self._server is not None

    @property
    def url(self) -> str:
        scheme = "https" if self.https_enabled else "http"
        return f"{scheme}://{self.host}:{self.port}"

    def start(self) -> bool:
        if self.https_enabled:
            ssl_context = self._build_ssl_context()
            if ssl_context is None:
                return False  # a warning explaining why was already printed

        try:
            server = ThreadingHTTPServer((self.host, self.port), RequestHandler)
        except (OSError, TypeError, ValueError) as error:
            print(f"[WARNING]: Mission Control could not start on {self.host}:{self.port} ({error}).")
            return False

        if self.https_enabled:
            try:
                server.socket = ssl_context.wrap_socket(server.socket, server_side=True)
            except ssl.SSLError as error:
                print(f"[WARNING]: Mission Control could not start HTTPS on {self.host}:{self.port} "
                      f"({error}). Check that https_cert and https_key are a matching certificate/key pair.")
                server.server_close()
                return False

        server.daemon_threads = True
        server.engine = self.engine
        server.web_root = self.web_root
        server.https_enabled = self.https_enabled

        self.port = server.server_address[1]
        self._server = server
        self._thread = Thread(target=server.serve_forever, name="starcore-api", daemon=True)
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

    def _build_ssl_context(self):
        """Loads https_cert/https_key into an SSLContext, or returns None (after
        printing exactly why) if HTTPS was requested but can't actually be
        served - startup fails closed rather than silently falling back to
        plain HTTP, since that would be a false sense of security.
        """
        if self.https_cert is None or self.https_key is None:
            print("[WARNING]: https_enabled is true but https_cert and/or https_key is not configured. "
                  "Mission Control was not started. See docs/deployment.md for HTTPS setup.")
            return None

        if not self.https_cert.is_file():
            print(f"[WARNING]: HTTPS certificate file not found: {self.https_cert}. Mission Control was not started.")
            return None

        if not self.https_key.is_file():
            print(f"[WARNING]: HTTPS private key file not found: {self.https_key}. Mission Control was not started.")
            return None

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            context.load_cert_chain(certfile=str(self.https_cert), keyfile=str(self.https_key))
        except ssl.SSLError as error:
            print(f"[WARNING]: HTTPS certificate/key could not be loaded ({error}). Mission Control was not started.")
            return None

        return context


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "StarCore"
    _responded = False
    _session_token = ""  # set by _authorized() for this request, so
                          # _handle_satellite() can hand it to a Satellite's
                          # Request without recomputing or re-validating it

    def do_GET(self):
        path = urlparse(self.path).path

        try:
            if not self._authorized(path):
                return
            if path in WRITE_ENDPOINTS:
                self._send_json({"error": f"{path} requires POST"}, status=405)
            elif path == "/api/auth/status":
                self._handle_auth_status()
            elif path == "/api/auth/sessions":
                self._handle_auth_sessions()
            elif path.startswith("/api/"):
                self._handle_api(path)
            else:
                self._handle_frontend(path)
        except Exception as error:
            if not self._responded:
                self._send_json({"error": f"internal error: {error}"}, status=500)

    def do_POST(self):
        path = urlparse(self.path).path

        try:
            if not self._authorized(path):
                return
            if path == "/api/auth/setup":
                self._handle_auth_setup()
            elif path == "/api/auth/login":
                self._handle_auth_login()
            elif path == "/api/auth/logout":
                self._handle_auth_logout()
            elif path == "/api/auth/sessions/revoke":
                self._handle_auth_revoke_session()
            elif path == "/api/commands/execute":
                self._handle_execute()
            elif path == "/api/shutdown":
                self._handle_shutdown()
            elif path == "/api/restart":
                self._handle_restart()
            elif path == "/api/configuration":
                self._handle_configuration_update()
            elif path.startswith(SATELLITE_PREFIX):
                self._handle_satellite(path, "POST")
            else:
                self._method_not_allowed()
        except Exception as error:
            if not self._responded:
                self._send_json({"error": f"internal error: {error}"}, status=500)

    def _authorized(self, path: str) -> bool:
        """True if this request may proceed without further checks.

        Every /api/ path (other than the always-open auth endpoints in
        AUTH_OPEN_ENDPOINTS - status/setup/login/logout) needs a valid
        session once an administrator account exists. Before that - a fresh,
        not-yet-configured install - the API is intentionally still open, the
        same way the frontend's own setup screen has to be reachable with no
        session at all. This is exactly why the default bind address stays
        127.0.0.1 (see engine/config.toml): exposing an unconfigured StarCore
        beyond localhost is the administrator's decision to make, not
        something this alone makes safe. Sends the 401 itself on failure, so
        callers only need to check the return value and return.
        """
        if not path.startswith("/api/") or path in AUTH_OPEN_ENDPOINTS:
            return True

        engine = self.server.engine
        if not engine.auth.is_bootstrapped:
            return True

        token = AuthStore.token_from_request(self.headers.get("Cookie", ""), self.headers.get("Authorization", ""))
        if engine.auth.validate_session(token):
            self._session_token = token
            return True

        self._send_json({"error": "authentication required"}, status=401)
        return False

    def do_PUT(self):
        self._method_not_allowed()

    def do_PATCH(self):
        self._method_not_allowed()

    def do_DELETE(self):
        self._method_not_allowed()

    def log_message(self, format, *args):
        # the CLI can share this process, so requests are not logged into its output
        pass

    def _handle_api(self, path: str):
        engine = self.server.engine

        if path == "/api/status":
            self._send_json(engine.status())
        elif path == "/api/satellites":
            self._send_json({"satellites": payloads.describe_satellites(engine)})
        elif path.startswith(SATELLITE_PREFIX):
            self._handle_satellite(path, "GET")
        elif path == "/api/commands":
            self._send_json({"commands": payloads.describe_commands(engine)})
        elif path == "/api/configuration":
            self._send_json(payloads.describe_configuration(engine))
        else:
            self._send_json({"error": f"unknown endpoint '{path}'"}, status=404)

    def _handle_satellite(self, path: str, method: str):
        engine = self.server.engine
        segments = [unquote(segment) for segment in path[len(SATELLITE_PREFIX):].split("/") if segment]
        name = segments[0] if segments else ""
        satellite = engine.registry.get(name) if name else None

        if satellite is None:
            self._send_json({"error": f"unknown satellite '{name}'"}, status=404)
            return

        if len(segments) == 1:
            if method == "GET":
                self._send_json(payloads.describe_satellite(engine, satellite))
            else:
                self._method_not_allowed()
            return

        if segments[1] == ASSETS_SEGMENT:
            if method == "GET":
                self._handle_asset(satellite, segments[2:])
            else:
                self._method_not_allowed()
            return

        if segments[1] in LIFECYCLE_ACTIONS or segments[1] == RELOAD_SEGMENT:
            if method == "POST":
                self._handle_satellite_action(engine, satellite, segments[1])
            else:
                self._method_not_allowed()
            return

        handler = satellite.routes.get(segments[1])
        if handler is None:
            self._send_json({"error": f"unknown endpoint '{path}'"}, status=404)
            return

        body = None
        raw = None
        if method == "POST":
            content_type = self.headers.get("Content-Type", "")
            # JSON (the default for every existing route) is parsed up front,
            # same as always; anything else - a file upload, in practice -
            # is handed to the satellite as a RawBody it reads in chunks,
            # rather than buffered whole into a dict that can never be huge
            if not content_type or content_type.startswith("application/json"):
                body = self._read_json_body()
                if body is None:
                    return  # a clean error response was already sent
            else:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = RawBody(self.rfile, length)

        query = {key: values[-1] for key, values in parse_qs(urlparse(self.path).query).items()}
        request = Request(engine, satellite, method, tuple(segments[2:]), query, body, raw, token=self._session_token)

        # a satellite handles its own resources, so its failures are isolated the
        # same way its state provider's are, and never reach the client as a trace
        try:
            response = handler(request)
        except Exception as error:
            print(f"[WARNING]: route '{segments[1]}' of satellite '{satellite.manifest.name}' failed: {error}")
            self._send_json({"error": "the satellite could not handle this request"}, status=500)
            return

        if not isinstance(response, Response):
            print(f"[WARNING]: route '{segments[1]}' of satellite '{satellite.manifest.name}' returned no response.")
            self._send_json({"error": "the satellite returned an invalid response"}, status=500)
            return

        self._send_response(response)

    # generic satellite lifecycle controls - enable, disable and reload work
    # the same way for every satellite, native or link, so unlike the routes a
    # satellite declares in its own api.py, these are handled directly by the
    # Core and never reach a satellite's code (see StarCore.set_satellite_enabled
    # / .reload_satellite, which do the actual work and are what a satellite's
    # own start()/stop() hooks and manifest reload run through)
    def _handle_satellite_action(self, engine, satellite, action: str):
        name = satellite.manifest.name
        try:
            if action == RELOAD_SEGMENT:
                result = engine.reload_satellite(name)
            else:
                result = engine.set_satellite_enabled(name, LIFECYCLE_ACTIONS[action])
        except SatelliteError as error:
            self._send_json({"error": str(error)}, status=404)
            return

        payload = {
            "satellite": payloads.describe_satellite(engine, result["satellite"]),
            "error": result["error"],
        }
        # a hook that raised is caught and reported, never left to crash the
        # request - but it's still a real failure, the same way an exception
        # escaping a run command is reported as a 500 by /api/commands/execute
        self._send_json(payload, status=500 if result["error"] else 200)

    def _handle_asset(self, satellite, segments: list):
        root = satellite.assets_path.resolve()
        if not root.is_dir() or not segments:
            self._send_json({"error": "the satellite provides no Mission Control assets"}, status=404)
            return

        target = (root / "/".join(segments)).resolve()
        if not target.is_relative_to(root):
            self._send_text("Forbidden.", status=403)
            return

        if not target.is_file():
            self._send_text(f"Not found: {'/'.join(segments)}", status=404)
            return

        self._send_bytes(target.read_bytes(), CONTENT_TYPES.get(target.suffix, "application/octet-stream"))

    def _handle_execute(self):
        body = self._read_json_body()
        if body is None:
            return  # a clean error response was already sent

        command = body.get("command") if isinstance(body, dict) else None
        if not isinstance(command, str) or not command.strip():
            self._send_json({"error": "'command' must be a non-empty string"}, status=400)
            return

        result = payloads.execute(self.server.engine, command)
        # a command that failed on its own terms (unknown name, printed
        # "[ERROR]: ...") is still a normal 200 - only an exception that
        # escaped the command function itself counts as a server error
        self._send_json(result, status=500 if result["error"] else 200)

    def _handle_configuration_update(self):
        body = self._read_json_body()
        if body is None:
            return  # a clean error response was already sent

        if not isinstance(body, dict):
            self._send_json({"error": "request body must be a JSON object"}, status=400)
            return

        section, key, value = body.get("section"), body.get("key"), body.get("value")
        if not isinstance(section, str) or not isinstance(key, str):
            self._send_json({"error": "'section' and 'key' must be strings"}, status=400)
            return

        try:
            self.server.engine.config.set(section, key, value)
        except ConfigurationError as error:
            self._send_json({"error": str(error)}, status=400)
            return

        self._send_json(payloads.describe_configuration(self.server.engine))

    def _session_cookie(self, token: str, max_age: int = SESSION_TTL_SECONDS) -> str:
        parts = [f"{SESSION_COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if getattr(self.server, "https_enabled", False):
            parts.append("Secure")
        return "; ".join(parts)

    def _handle_auth_status(self):
        engine = self.server.engine
        token = AuthStore.token_from_request(self.headers.get("Cookie", ""), self.headers.get("Authorization", ""))
        self._send_json({
            "bootstrapped": engine.auth.is_bootstrapped,
            "authenticated": engine.auth.validate_session(token),
        })

    def _handle_auth_setup(self):
        engine = self.server.engine
        body = self._read_json_body()
        if body is None:
            return  # a clean error response was already sent

        username = str(body.get("username", "")) if isinstance(body, dict) else ""
        password = str(body.get("password", "")) if isinstance(body, dict) else ""
        try:
            token = engine.auth.bootstrap(username, password)
        except AuthError as error:
            self._send_json({"error": str(error)}, status=409)
            return

        self._send_json({"message": "Administrator account created."},
                         headers={"Set-Cookie": self._session_cookie(token)})

    def _handle_auth_login(self):
        engine = self.server.engine
        body = self._read_json_body()
        if body is None:
            return  # a clean error response was already sent

        username = str(body.get("username", "")) if isinstance(body, dict) else ""
        password = str(body.get("password", "")) if isinstance(body, dict) else ""
        # "kind"/"device_name" are optional labels a non-browser caller (a
        # future mobile client, chiefly) can send to identify itself in the
        # "your devices" list below - see AuthStore.create_session(). A
        # browser never sends either, and simply gets a "web" session exactly
        # as before; this is additive, not a second login mechanism.
        kind = str(body.get("kind", "web")) if isinstance(body, dict) else "web"
        device_name = body.get("device_name") if isinstance(body, dict) else None
        try:
            token = engine.auth.login(username, password, kind=kind, device_name=device_name)
        except AuthError as error:
            self._send_json({"error": str(error)}, status=401)
            return

        self._send_json({"message": "Logged in."}, headers={"Set-Cookie": self._session_cookie(token)})

    def _handle_auth_logout(self):
        engine = self.server.engine
        token = AuthStore.token_from_request(self.headers.get("Cookie", ""), self.headers.get("Authorization", ""))
        engine.auth.logout(token)
        self._send_json({"message": "Logged out."}, headers={"Set-Cookie": self._session_cookie("", max_age=0)})

    def _handle_auth_sessions(self):
        engine = self.server.engine
        token = AuthStore.token_from_request(self.headers.get("Cookie", ""), self.headers.get("Authorization", ""))
        self._send_json({"sessions": engine.auth.list_sessions(current_token=token)})

    def _handle_auth_revoke_session(self):
        engine = self.server.engine
        body = self._read_json_body()
        if body is None:
            return  # a clean error response was already sent

        session_id = body.get("session_id") if isinstance(body, dict) else None
        if not isinstance(session_id, str) or not session_id:
            self._send_json({"error": "'session_id' must be a non-empty string"}, status=400)
            return

        found = engine.auth.revoke_session(session_id)
        if not found:
            self._send_json({"error": f"no session '{session_id}'"}, status=404)
            return

        self._send_json({"revoked": session_id})

    def _handle_shutdown(self):
        engine = self.server.engine
        self._send_json({"message": "StarCore is shutting down."})
        # stop the Core shortly after the response is flushed, instead of
        # inline: engine.stop() tears down this very server, and doing that
        # before the response is written back would race the client's request
        Timer(0.2, engine.stop).start()

    def _handle_restart(self):
        engine = self.server.engine
        self._send_json({"message": "StarCore is restarting."})
        # same race-avoidance as _handle_shutdown - request_restart() ends up
        # calling engine.stop(), which tears down this very server
        Timer(0.2, engine.request_restart).start()

    def _handle_frontend(self, path: str):
        root = Path(self.server.web_root).resolve()
        if not root.is_dir():
            self._send_text(f"Mission Control is not available: {self.server.web_root} not found.", status=404)
            return

        target = (root / (path.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to(root):
            self._send_text("Forbidden.", status=403)
            return

        if not target.is_file():
            self._send_text(f"Not found: {path}", status=404)
            return

        content_type = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send_bytes(target.read_bytes(), content_type)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""

        if not raw:
            return {}

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "request body must be valid JSON"}, status=400)
            return None

    def _method_not_allowed(self):
        self._send_json({"error": "the StarCore API is read-only"}, status=405)

    def _send_response(self, response: Response):
        if response.path is None:
            self._send_json(response.payload, status=response.status)
            return

        try:
            self._send_file(Path(response.path), response.content_type, response.cache, response.download_name)
        except OSError as error:
            print(f"[WARNING]: {response.path} could not be read ({error}).")
            if not self._responded:
                self._send_json({"error": "the requested file is not available"}, status=404)

    # files are streamed rather than read into memory, and a Range request is
    # answered with the part that was asked for, so a browser can seek in a large
    # file a satellite serves without downloading all of it
    def _send_file(self, path: Path, content_type: str, cache: str = None, download_name: str = None):
        size = path.stat().st_size
        start, end = self._requested_range(size)
        length = end - start + 1

        self._responded = True
        self.send_response(206 if length != size else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache or "no-store")
        if length != size:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_name:
            self.send_header("Content-Disposition", _content_disposition(download_name))
        self.end_headers()

        with open(path, "rb") as file:
            file.seek(start)
            remaining = length
            while remaining > 0:
                chunk = file.read(min(FILE_CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _requested_range(self, size: int) -> tuple:
        header = self.headers.get("Range", "")
        if not header.startswith("bytes=") or "," in header:
            return 0, max(size - 1, 0)

        first, _, last = header[len("bytes="):].partition("-")
        try:
            if not first:
                start = max(size - int(last), 0)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
        except ValueError:
            return 0, max(size - 1, 0)

        if start >= size or start > end:
            return 0, max(size - 1, 0)

        return start, min(end, size - 1)

    def _send_json(self, payload, status: int = 200, headers: dict = None):
        try:
            body = json.dumps(payload, indent=2).encode("utf-8")
        except (TypeError, ValueError) as error:
            status = 500
            body = json.dumps({"error": f"response could not be serialized: {error}"}).encode("utf-8")

        self._send_bytes(body, "application/json; charset=utf-8", status, headers=headers)

    def _send_text(self, message: str, status: int = 200):
        self._send_bytes(message.encode("utf-8"), "text/plain; charset=utf-8", status)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200, cache: str = None, headers: dict = None):
        self._responded = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache or "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)
