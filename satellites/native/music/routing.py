"""Shared plumbing for Music's routes: method checks, who is asking, and error mapping."""

import re

from starcore.api.response import error_response, json_response

from .collection import CollectionError
from .connect import ConnectError
from .library import MusicScanError, library
from .playlists import PlaylistError
from .transcode import TranscodeError
from .users import NotSignedIn, PreferenceError, current_session, current_user

IDENTIFIER = re.compile(r"^[0-9a-f]{8,64}$")
CLIENT_ERRORS = (PlaylistError, CollectionError, ConnectError, PreferenceError, MusicScanError)


class Call:
    """What a handler gets: the library, the listener, and the request's parts."""

    def __init__(self, request):
        self.request = request
        self.music = library(request.satellite)
        self.user = current_user(request)
        self.method = request.method
        self.path = request.path
        self.query = request.query or {}
        body = request.body
        self.body = body if isinstance(body, dict) else {}

    @property
    def session(self) -> str:
        return current_session(self.request)

    def segment(self, index: int, default=None):
        return self.path[index] if len(self.path) > index else default

    def integer(self, name: str, default: int, low: int = 0, high: int = 10_000) -> int:
        try:
            value = int(self.query.get(name, default))
        except (TypeError, ValueError):
            value = default
        return max(low, min(value, high))


def route(*methods):
    def decorate(handler):
        def wrapped(request):
            if request.method not in methods:
                allowed = " and ".join(methods)
                return error_response(f"only {allowed} {'is' if len(methods) == 1 else 'are'} supported here",
                                      status=405)
            try:
                return handler(Call(request))
            except NotSignedIn as error:
                return error_response(str(error), status=401)
            except LookupError as error:
                return error_response(str(error).strip("'\"") or "not found", status=404)
            except TranscodeError as error:
                return error_response(str(error), status=503)
            except CLIENT_ERRORS as error:
                return error_response(str(error), status=400)
            except (TypeError, ValueError) as error:
                return error_response(f"invalid request: {error}", status=400)
        wrapped.__name__ = handler.__name__
        wrapped.__doc__ = handler.__doc__
        return wrapped
    return decorate


def identifier(value, what: str = "item") -> str:
    if not isinstance(value, str) or not IDENTIFIER.match(value):
        raise LookupError(f"unknown {what} '{value}'")
    return value


def ok(payload, status: int = 200):
    return json_response(payload, status=status)
