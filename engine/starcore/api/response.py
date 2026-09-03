from pathlib import Path


class Request:
    """What a satellite route handler receives."""

    def __init__(self, engine, satellite, method: str, path: tuple, query: dict, body=None):
        self.engine = engine
        self.satellite = satellite
        self.method = method
        self.path = path
        self.query = query
        self.body = body


class Response:
    """What a satellite route handler returns: either a payload or a file to serve."""

    def __init__(self, status: int = 200, payload=None, path: Path = None, content_type: str = None, cache: str = None):
        self.status = status
        self.payload = payload
        self.path = path
        self.content_type = content_type
        self.cache = cache


def json_response(payload, status: int = 200) -> Response:
    return Response(status=status, payload=payload)


def file_response(path, content_type: str, cache: str = None) -> Response:
    return Response(path=Path(path), content_type=content_type, cache=cache)


def error_response(message: str, status: int = 404) -> Response:
    return Response(status=status, payload={"error": message})
