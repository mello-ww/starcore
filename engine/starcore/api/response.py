from pathlib import Path


class Request:
    """What a satellite route handler receives."""

    def __init__(self, engine, satellite, method: str, path: tuple, query: dict, body=None, raw=None, token: str = ""):
        self.engine = engine
        self.satellite = satellite
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        # set instead of `body` for a POST whose Content-Type isn't JSON (a
        # file upload, in practice) - a RawBody the handler reads in chunks
        self.raw = raw
        # the caller's already-validated session token (see AuthStore), so a
        # Satellite route can recognize *which* session this is - session-aware
        # authorization of its own, on top of the Core's own "is there a valid
        # session at all" gate - without re-implementing any part of session
        # validation itself. Empty when the Core hasn't required a session for
        # this request at all (StarCore not yet bootstrapped). The Locked
        # Folder Satellite is what actually uses this (see docs/satellites/locked_folder.md);
        # every other existing route ignores it exactly as before.
        self.token = token


class Response:
    """What a satellite route handler returns: either a payload or a file to serve."""

    def __init__(self, status: int = 200, payload=None, path: Path = None, content_type: str = None,
                 cache: str = None, download_name: str = None, stream=None):
        self.status = status
        self.payload = payload
        self.path = path
        # instead of a path: content a satellite produces on the fly (see
        # stream_response) - served exactly like a file, Range requests included
        self.stream = stream
        self.content_type = content_type
        self.cache = cache
        # when set, the file is sent with Content-Disposition: attachment - a
        # generic way for any satellite to say "this should download, not open
        # in the browser" (File Explorer uses it; nothing else has needed to yet)
        self.download_name = download_name


def json_response(payload, status: int = 200) -> Response:
    return Response(status=status, payload=payload)


def file_response(path, content_type: str, cache: str = None, download_name: str = None) -> Response:
    return Response(path=Path(path), content_type=content_type, cache=cache, download_name=download_name)


def stream_response(source, content_type: str, cache: str = None, download_name: str = None) -> Response:
    """Serves content that isn't a plain file on disk - decrypted on the fly,
    say. `source` has a `size` (bytes), a `read_range(start, end)` generator
    yielding bytes start..end inclusive, and `close()`. If the first chunk
    can't be produced, the client gets an error status; if a later one can't,
    the connection is closed early instead of carrying on with bad data."""
    return Response(stream=source, content_type=content_type, cache=cache, download_name=download_name)


def error_response(message: str, status: int = 404) -> Response:
    return Response(status=status, payload={"error": message})


class RawBody:
    """A POST body that wasn't (and shouldn't be) parsed as JSON - read via
    read(), in chunks, so a satellite streaming a large upload to disk never
    has to hold the whole thing in memory. Content-Type decides whether a
    satellite route receives this or a parsed dict as Request.body - see
    starcore.api.server._handle_satellite.
    """

    def __init__(self, rfile, length: int):
        self._rfile = rfile
        self.length = length
        self._remaining = length

    def read(self, size: int = 65536) -> bytes:
        if self._remaining <= 0:
            return b""
        chunk = self._rfile.read(min(size, self._remaining))
        self._remaining -= len(chunk)
        return chunk

    def __iter__(self):
        while True:
            chunk = self.read()
            if not chunk:
                return
            yield chunk
