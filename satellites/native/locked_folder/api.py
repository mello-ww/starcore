"""Mission Control routes, served under /api/satellites/LockedFolder/.

The Locked Folder owns everything specific to *being locked*: where the
root is, whether a PIN is set, whether *this* session currently has it
open, biometric unlock for enrolled phones, and the vault's own media view
and moves to and from Photos. File Explorer's routes stay usable on the
vault too, and refuse every path inside it unless this session has
unlocked it (see satellites/native/file_explorer/locked_folder_guard.py).

Everything that reads or changes the vault, or loosens its protection,
checks this session's unlock on the server - hiding the Locked Folder from
navigation is never what keeps it private. See docs/satellites/locked_folder.md.
"""

import base64
import binascii

from starcore.api.response import error_response, file_response, json_response

from . import configuration, vault
from .runtime import runtime, validate_pin

# settings that would loosen protection or point it somewhere else once a
# PIN guards the vault - changing them needs this session to be unlocked
GUARDED_SETTINGS = {"locked_folder_path", "session_timeout_seconds", "max_pin_attempts", "lockout_seconds"}


def routes() -> dict:
    return {
        "configuration": configuration_route,
        "status": status,
        "pin": pin,
        "unlock": unlock,
        "lock": lock,
        "delink": delink,
        "media": media,
        "move_in": move_in,
        "move_out": move_out,
        "biometric": biometric,
    }


def _limits(request):
    config = request.satellite.config
    return int(config.get("max_pin_attempts", 5)), int(config.get("lockout_seconds", 300))


def _too_many(retry_after: int):
    response = error_response(f"too many incorrect attempts - try again in {retry_after}s", status=429)
    response.payload["retry_after"] = retry_after
    return response


def _protected(live) -> bool:
    """Whether a PIN currently guards a configured vault."""
    return live.pin_set and live.configured_root is not None


def _require_unlocked(request, live):
    """None when this session has the vault open, otherwise the error to return."""
    if not request.token:
        return error_response("authentication required", status=401)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured yet", status=400)
    if not live.is_unlocked(request.token):
        return error_response("the Locked Folder is locked - unlock it first", status=403)
    return None


def configuration_route(request):
    if request.method == "GET":
        return json_response(configuration.describe(request.satellite))

    if request.method != "POST":
        return error_response("only GET and POST are supported here", status=405)

    body = request.body or {}
    key, value = body.get("key"), body.get("value")
    if not isinstance(key, str):
        return error_response("'key' must be a string", status=400)

    live = runtime(request.satellite)
    if key in GUARDED_SETTINGS and _protected(live) and not live.is_unlocked(request.token):
        # otherwise anyone signed in could point the Locked Folder elsewhere
        # (or loosen its limits) and reach the old vault without the PIN
        return error_response("unlock the Locked Folder before changing its settings", status=403)

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
        # docs/satellites/locked_folder.md, "The configured directory can disappear"
        "path_exists": root.is_dir() if root is not None else None,
        "pin_set": live.pin_set,
        "pin_unreadable": live.pin_unreadable,
        "unlocked": unlocked,
        "expires_at": expires,
        "session_timeout_seconds": int(request.satellite.config.get("session_timeout_seconds", 900)),
        "photos_available": vault.photo_library(request.engine) is not None,
        "biometric_devices": live.device_count(),
    })


def pin(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    if live.pin_unreadable:
        return error_response("the stored PIN could not be read - repair or remove pin.json on the server",
                              status=409)

    body = request.body or {}
    try:
        new_pin = validate_pin(body.get("pin"))
    except ValueError as error:
        return error_response(str(error), status=400)

    if live.pin_set:
        current_pin = body.get("current_pin")
        if not isinstance(current_pin, str) or not current_pin:
            return error_response("the current PIN is required to change it", status=401)
        max_attempts, lockout_seconds = _limits(request)
        retry_after = live.begin_attempt(request.token, max_attempts, lockout_seconds)
        if retry_after:
            return _too_many(retry_after)
        if not live.verify_pin(current_pin):
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
    if live.pin_unreadable:
        return error_response("the stored PIN could not be read - repair or remove pin.json on the server",
                              status=409)
    if not live.pin_set:
        return error_response("no PIN has been set yet - configure one from this page first", status=400)

    body = request.body or {}
    pin_value = body.get("pin")
    if not isinstance(pin_value, str) or not pin_value:
        return error_response("'pin' must be a non-empty string", status=400)

    max_attempts, lockout_seconds = _limits(request)
    retry_after = live.begin_attempt(request.token, max_attempts, lockout_seconds)
    if retry_after:
        return _too_many(retry_after)

    if not live.verify_pin(pin_value):
        return error_response("incorrect PIN", status=401)

    return _grant_unlock(request, live)


def _grant_unlock(request, live):
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
    for a directory that was deleted (or moved) outside StarCore. See
    docs/satellites/locked_folder.md, "Delinking".

    Needs this session unlocked once a PIN is set: delinking takes the
    protection off that directory, so it must never be a way around the PIN
    (or around a brute-force lockout). The PIN itself is left alone, so a
    PIN already set keeps working once a new location is configured.
    """
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured", status=400)
    if live.pin_set and not live.is_unlocked(request.token):
        return error_response("unlock the Locked Folder before delinking it", status=403)

    configuration.update(request.engine, request.satellite, "locked_folder_path", "")
    return json_response({"delinked": True})


# ---------- the vault as media ----------

def media(request):
    """GET media -> every file in the vault; GET media/file?path=... -> one file."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    live = runtime(request.satellite)
    refused = _require_unlocked(request, live)
    if refused is not None:
        return refused
    root = live.configured_root
    if not root.is_dir():
        return error_response("the Locked Folder directory is missing", status=404)

    if not request.path:
        return json_response(vault.list_items(root))
    if request.path != ("file",):
        return error_response("unknown endpoint", status=404)

    try:
        target = vault.resolve_item(root, request.query.get("path"))
    except vault.VaultError as error:
        return error_response(str(error), status=error.status)
    content_type = vault.MEDIA_TYPES.get(target.suffix.lower(), (None, "application/octet-stream"))[1]
    # never cached by the browser, so nothing private outlives the unlock on disk
    return file_response(target, content_type, cache="private, no-store",
                         download_name=target.name if request.query.get("download") == "1" else None)


def move_in(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    live = runtime(request.satellite)
    refused = _require_unlocked(request, live)
    if refused is not None:
        return refused
    if not live.configured_root.is_dir():
        return error_response("the Locked Folder directory is missing", status=404)

    try:
        result = vault.move_in(request.engine, live, live.configured_root, (request.body or {}).get("photo_ids"))
    except vault.VaultError as error:
        return error_response(str(error), status=error.status)
    return json_response(result, status=200 if result["moved"] or not result["failed"] else 409)


def move_out(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    live = runtime(request.satellite)
    refused = _require_unlocked(request, live)
    if refused is not None:
        return refused

    try:
        result = vault.move_out(request.engine, live, live.configured_root, (request.body or {}).get("paths"))
    except vault.VaultError as error:
        return error_response(str(error), status=error.status)
    return json_response(result, status=200 if result["moved"] or not result["failed"] else 409)


# ---------- biometric unlock ----------

def biometric(request):
    """POST biometric/enroll    {pin, public_key, device_name} -> {key_id}
    POST biometric/challenge {key_id}                       -> {challenge}
    POST biometric/unlock    {key_id, challenge, signature} -> like /unlock
    POST biometric/revoke    {key_id}                       -> {revoked}

    Enrolling needs the PIN. Unlocking needs a signature over a fresh,
    single-use challenge by the key enrolled for that device."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    action = request.path[0] if len(request.path) == 1 else ""
    body = request.body or {}
    key_id = body.get("key_id")

    if action == "revoke":
        # removing a device only ever takes access away, so it needs no PIN
        if not isinstance(key_id, str) or not live.remove_device(key_id):
            return error_response("unknown biometric device", status=404)
        return json_response({"revoked": True})

    if action not in ("enroll", "challenge", "unlock"):
        return error_response("unknown endpoint", status=404)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured yet", status=400)
    if live.pin_unreadable or not live.pin_set:
        return error_response("set a PIN before turning on biometric unlock", status=400)

    max_attempts, lockout_seconds = _limits(request)

    if action == "enroll":
        pin_value = body.get("pin")
        if not isinstance(pin_value, str) or not pin_value:
            return error_response("'pin' is required to turn on biometric unlock", status=400)
        try:
            public_key = _decode(body.get("public_key"))
        except ValueError:
            return error_response("'public_key' must be a base64 RSA public key", status=400)
        retry_after = live.begin_attempt(request.token, max_attempts, lockout_seconds)
        if retry_after:
            return _too_many(retry_after)
        if not live.verify_pin(pin_value):
            return error_response("incorrect PIN", status=401)
        live.record_success(request.token)
        try:
            new_id = live.add_device(public_key, body.get("device_name"))
        except ValueError as error:
            return error_response(str(error), status=400)
        return json_response({"key_id": new_id})

    if not live.has_device(key_id):
        # e.g. the PIN changed since this phone enrolled - it falls back to the PIN
        return error_response("this device is not enrolled for biometric unlock", status=404)

    if action == "challenge":
        return json_response({"challenge": live.new_challenge(request.token, key_id)})

    try:
        signature = _decode(body.get("signature"))
    except ValueError:
        return error_response("'signature' must be base64", status=400)
    retry_after = live.begin_attempt(request.token, max_attempts, lockout_seconds)
    if retry_after:
        return _too_many(retry_after)
    if not live.verify_signature(request.token, key_id, body.get("challenge", ""), signature):
        return error_response("biometric unlock failed - use the PIN", status=401)
    return _grant_unlock(request, live)


def _decode(value) -> bytes:
    if not isinstance(value, str) or not value.strip() or len(value) > 16384:
        raise ValueError("expected base64")
    try:
        # Android's Base64.DEFAULT wraps lines, so whitespace is ignored
        return base64.b64decode("".join(value.split()), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("expected base64") from error
