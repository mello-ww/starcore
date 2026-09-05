"""Mission Control routes, served under /api/satellites/LockedFolder/.

The Locked Folder does not browse or serve files itself - once unlocked,
the protected root is browsed the ordinary way, through File Explorer's own
`entries`/`content`/`upload`/`mkdir`/`rename`/`delete` routes (see
satellites/native/file_explorer/locked_folder_guard.py), which now refuse
every one of those routes for a path inside the configured root unless this
session has unlocked it. This satellite owns exactly the parts that are
specific to *being locked*: where the root is, whether a PIN is set, and
whether *this* session currently has it open - see docs/locked_folder.md.
"""

from starcore.api.response import error_response, json_response

from . import configuration
from .runtime import runtime, validate_pin


def routes() -> dict:
    return {
        "configuration": configuration_route,
        "status": status,
        "pin": pin,
        "unlock": unlock,
        "lock": lock,
        "delink": delink,
    }


def configuration_route(request):
    if request.method == "GET":
        return json_response(configuration.describe(request.satellite))

    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    body = request.body or {}
    key, value = body.get("key"), body.get("value")
    if not isinstance(key, str):
        return error_response("'key' must be a string", status=400)

    try:
        return json_response(configuration.update(request.engine, request.satellite, key, value))
    except configuration.ConfigurationError as error:
        return error_response(str(error), status=400)


def status(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    live = runtime(request.satellite)
    root = live.configured_root
    unlocked = live.is_unlocked(request.token)
    expires = live.expires_at(request.token) if unlocked else None

    return json_response({
        "configured": root is not None,
        "path": str(root) if root is not None else None,
        # None when nothing is configured at all (there is no directory to
        # ask about); otherwise whether the configured path actually still
        # exists on disk - a directory deleted outside StarCore (Windows
        # File Explorer, `rm -rf`, ...) does not un-configure the Locked
        # Folder by itself, so this is how Mission Control tells "configured
        # and fine" apart from "configured, but the directory is gone" - see
        # docs/locked_folder.md, "The configured directory can disappear"
        "path_exists": root.is_dir() if root is not None else None,
        "pin_set": live.pin_set,
        "unlocked": unlocked,
        "expires_at": expires,
        "session_timeout_seconds": int(request.satellite.config.get("session_timeout_seconds", 900)),
    })


def pin(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    max_attempts = int(request.satellite.config.get("max_pin_attempts", 5))
    lockout_seconds = int(request.satellite.config.get("lockout_seconds", 300))

    allowed, retry_after = live.check_rate_limit(request.token, lockout_seconds)
    if not allowed:
        return error_response(f"too many incorrect attempts - try again in {retry_after}s", status=429)

    body = request.body or {}
    try:
        new_pin = validate_pin(body.get("pin"))
    except ValueError as error:
        return error_response(str(error), status=400)

    if live.pin_set:
        current_pin = body.get("current_pin")
        if not isinstance(current_pin, str) or not live.verify_pin(current_pin):
            live.record_failure(request.token, max_attempts, lockout_seconds)
            return error_response("the current PIN is incorrect", status=401)

    live.record_success(request.token)
    live.set_pin(new_pin)
    return json_response({"pin_set": True})


def unlock(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured yet", status=400)
    if not live.pin_set:
        return error_response("no PIN has been set yet - configure one from this page first", status=400)

    max_attempts = int(request.satellite.config.get("max_pin_attempts", 5))
    lockout_seconds = int(request.satellite.config.get("lockout_seconds", 300))
    allowed, retry_after = live.check_rate_limit(request.token, lockout_seconds)
    if not allowed:
        return error_response(f"too many incorrect attempts - try again in {retry_after}s", status=429)

    body = request.body or {}
    pin_value = body.get("pin")
    if not isinstance(pin_value, str) or not pin_value:
        return error_response("'pin' must be a non-empty string", status=400)

    if not live.verify_pin(pin_value):
        live.record_failure(request.token, max_attempts, lockout_seconds)
        return error_response("incorrect PIN", status=401)

    live.record_success(request.token)
    timeout = int(request.satellite.config.get("session_timeout_seconds", 900))
    live.unlock(request.token, timeout)
    return json_response({"unlocked": True, "expires_at": live.expires_at(request.token)})


def lock(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    runtime(request.satellite).lock(request.token)
    return json_response({"locked": True})


def delink(request):
    """Removes the Locked Folder's association with its configured
    directory, without touching that directory on disk at all - the fix
    for a directory that was deleted (or moved) outside StarCore, which
    would otherwise leave Mission Control reporting a location that no
    longer exists as if it were still safely protected. See
    docs/locked_folder.md, "Delinking".

    Deliberately just a thin wrapper around the same configuration.update()
    every other change to locked_folder_path already goes through (the
    generic Satellite configuration route above, or Photo's directory
    picker use it too) - clearing the path already invalidates every
    existing unlock and brute-force lockout (see configuration.py), so
    nothing here re-implements any of that. The PIN itself is left alone:
    delinking removes the location, not the credential, so a PIN already
    set keeps working once a new location is configured.
    """
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured", status=400)

    configuration.update(request.engine, request.satellite, "locked_folder_path", "")
    return json_response({"delinked": True})
