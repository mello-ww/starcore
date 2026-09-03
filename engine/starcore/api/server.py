from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread, Timer
from urllib.parse import parse_qs, unquote, urlparse
import json

from . import payloads
from .response import Request, Response
from ..engine_config import ConfigurationError

SATELLITE_PREFIX = "/api/satellites/"
WRITE_ENDPOINTS = ("/api/commands/execute", "/api/shutdown")

# reserved below a satellite, so a satellite cannot claim it as a route name
ASSETS_SEGMENT = "assets"

FILE_CHUNK = 64 * 1024

CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}


class ApiServer:
    def __init__(self, engine, host: str, port: int, web_root: Path):
        self.engine = engine
        self.host = host
        self.port = port
        self.web_root = web_root
        self._server = None
        self._thread = None

    @property
    def running(self) -> bool:
        return self._server is not None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> bool:
        try:
            server = ThreadingHTTPServer((self.host, self.port), RequestHandler)
        except (OSError, TypeError, ValueError) as error:
            print(f"[WARNING]: Mission Control could not start on {self.host}:{self.port} ({error}).")
            return False

        server.daemon_threads = True
        server.engine = self.engine
        server.web_root = self.web_root

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


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "StarCore"
    _responded = False

    def do_GET(self):
        path = urlparse(self.path).path

        try:
            if path in WRITE_ENDPOINTS:
                self._send_json({"error": f"{path} requires POST"}, status=405)
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
            if path == "/api/commands/execute":
                self._handle_execute()
            elif path == "/api/shutdown":
                self._handle_shutdown()
            elif path == "/api/configuration":
                self._handle_configuration_update()
            elif path.startswith(SATELLITE_PREFIX):
                self._handle_satellite(path, "POST")
            else:
                self._method_not_allowed()
        except Exception as error:
            if not self._responded:
                self._send_json({"error": f"internal error: {error}"}, status=500)

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

        handler = satellite.routes.get(segments[1])
        if handler is None:
            self._send_json({"error": f"unknown endpoint '{path}'"}, status=404)
            return

        body = None
        if method == "POST":
            body = self._read_json_body()
            if body is None:
                return  # a clean error response was already sent

        query = {key: values[-1] for key, values in parse_qs(urlparse(self.path).query).items()}
        request = Request(engine, satellite, method, tuple(segments[2:]), query, body)

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

    def _handle_shutdown(self):
        engine = self.server.engine
        self._send_json({"message": "StarCore is shutting down."})
        # stop the Core shortly after the response is flushed, instead of
        # inline: engine.stop() tears down this very server, and doing that
        # before the response is written back would race the client's request
        Timer(0.2, engine.stop).start()

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
            self._send_file(Path(response.path), response.content_type, response.cache)
        except OSError as error:
            print(f"[WARNING]: {response.path} could not be read ({error}).")
            if not self._responded:
                self._send_json({"error": "the requested file is not available"}, status=404)

    # files are streamed rather than read into memory, and a Range request is
    # answered with the part that was asked for, so a browser can seek in a large
    # file a satellite serves without downloading all of it
    def _send_file(self, path: Path, content_type: str, cache: str = None):
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

    def _send_json(self, payload, status: int = 200):
        try:
            body = json.dumps(payload, indent=2).encode("utf-8")
        except (TypeError, ValueError) as error:
            status = 500
            body = json.dumps({"error": f"response could not be serialized: {error}"}).encode("utf-8")

        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _send_text(self, message: str, status: int = 200):
        self._send_bytes(message.encode("utf-8"), "text/plain; charset=utf-8", status)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200, cache: str = None):
        self._responded = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache or "no-store")
        self.end_headers()
        self.wfile.write(body)
