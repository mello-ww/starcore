from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread, Timer
from urllib.parse import unquote, urlparse
import json

from . import payloads

SATELLITE_PREFIX = "/api/satellites/"
WRITE_ENDPOINTS = ("/api/commands/execute", "/api/shutdown")

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
                self._handle_static(path)
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
            name = unquote(path[len(SATELLITE_PREFIX):]).strip("/")
            satellite = engine.registry.get(name) if name else None
            if satellite is None:
                self._send_json({"error": f"unknown satellite '{name}'"}, status=404)
            else:
                self._send_json(payloads.describe_satellite(engine, satellite))
        elif path == "/api/commands":
            self._send_json({"commands": payloads.describe_commands(engine)})
        else:
            self._send_json({"error": f"unknown endpoint '{path}'"}, status=404)

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

    def _handle_shutdown(self):
        engine = self.server.engine
        self._send_json({"message": "StarCore is shutting down."})
        # stop the Core shortly after the response is flushed, instead of
        # inline: engine.stop() tears down this very server, and doing that
        # before the response is written back would race the client's request
        Timer(0.2, engine.stop).start()

    def _handle_static(self, path: str):
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

    def _send_json(self, payload, status: int = 200):
        try:
            body = json.dumps(payload, indent=2).encode("utf-8")
        except (TypeError, ValueError) as error:
            status = 500
            body = json.dumps({"error": f"response could not be serialized: {error}"}).encode("utf-8")

        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _send_text(self, message: str, status: int = 200):
        self._send_bytes(message.encode("utf-8"), "text/plain; charset=utf-8", status)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200):
        self._responded = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
