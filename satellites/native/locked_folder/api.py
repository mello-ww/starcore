"""Mission Control routes, served under /api/satellites/LockedFolder/.

The Locked Folder owns everything specific to *being locked*: where the
root is, whether a PIN is set, whether *this* session currently has it
open, biometric unlock for enrolled phones, the vault's own media view,
uploads, deletes and moves to and from Photos, and its encryption (see
encryption.py). File Explorer refuses every path inside the vault unless
this session has unlocked it - and, once the vault is encrypted, refuses it
altogether (see satellites/native/file_explorer/locked_folder_guard.py).

Everything that reads or changes the vault, or loosens its protection,
checks this session's unlock on the server - hiding the Locked Folder from
navigation is never what keeps it private. Damaged or edited security state
(an unreadable PIN file, a PIN record that doesn't match the vault, attempt
counters that can't be saved) always keeps the vault locked.
See docs/satellites/locked_folder.md.
"""

import base64
import binascii
import threading

from starcore.api.response import error_response, file_response, json_response, stream_response

from . import configuration, crypto, encryption, thumbnails, vault
from .runtime import SecurityStateError, runtime, validate_pin

# settings that would loosen protection or point it somewhere else once a
# PIN guards the vault - changing them needs this session to be unlocked
GUARDED_SETTINGS = {"locked_folder_path", "session_timeout_seconds", "max_pin_attempts", "lockout_seconds"}

PROBLEMS = {
    "pin_unreadable": ("the stored PIN could not be read, so the Locked Folder stays locked - "
                       "use the recovery key, or repair pin.json on the server", 409),
    "pin_tampered": ("the Locked Folder's PIN record was changed outside StarCore, so it stays locked - "
                     "use the recovery key", 409),
    "key_unavailable": ("this server can't open the Locked Folder's encryption key - "
                        "use the recovery key to open it here", 409),
    "keyring_damaged": ("the Locked Folder's keyring is missing or damaged, so its files can't be decrypted", 409),
    "encryption_unavailable": ("the Locked Folder is encrypted, but StarCore's encryption support isn't "
                               "installed on this server", 503),
}

_migration_lock = threading.Lock()


def routes() -> dict:
    return {
        "configuration": configuration_route,
        "status": status,
        "pin": pin,
        "unlock": unlock,
        "lock": lock,
        "delink": delink,
        "media": media,
        "upload": upload,
        "delete": delete,
        "move_in": move_in,
        "move_out": move_out,
        "biometric": biometric,
        "encryption": encryption_route,
        "recover": recover,
    }


def _limits(request):
    config = request.satellite.config
    return int(config.get("max_pin_attempts", 5)), int(config.get("lockout_seconds", 300))


def _too_many(retry_after: int):
    response = error_response(f"too many incorrect attempts - try again in {retry_after}s", status=429)
    response.payload["retry_after"] = retry_after
    return response


def _problem(code: str):
    message, status_code = PROBLEMS.get(code, ("the Locked Folder can't be opened right now", 409))
    response = error_response(message, status=status_code)
    response.payload["problem"] = code
    return response


def _begin(request, live, kind: str = "pin"):
    """None when this attempt may go ahead (it is already counted), otherwise
    the response to return - including when the count can't be saved."""
    max_attempts, lockout_seconds = _limits(request)
    try:
        retry_after = live.begin_attempt(request.token, max_attempts, lockout_seconds, kind=kind)
    except SecurityStateError:
        return error_response("the Locked Folder could not record this attempt, so it was refused - "
                              "check the server's disk", status=503)
    return _too_many(retry_after) if retry_after else None


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


def _require_idle(live):
    if live.migration is not None and live.migration.running:
        return error_response("the Locked Folder is being encrypted - try again when it has finished", status=409)
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
    if key == "locked_folder_path" and _require_idle(live) is not None:
        return _require_idle(live)

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
        # when the stored PIN was last set, so "incorrect PIN" on a vault someone believes is new
        # can be told apart from a missing setup step; a date, never anything about the PIN itself
        "pin_set_at": live.pin_set_at(),
        "pin_unreadable": live.pin_unreadable,
        "unlocked": unlocked,
        "expires_at": expires,
        "session_timeout_seconds": int(request.satellite.config.get("session_timeout_seconds", 900)),
        "photos_available": vault.photo_library(request.engine) is not None,
        "biometric_devices": live.device_count(),
        # diagnostics for whoever administers the server: never a PIN, key or token
        "security": {"problem": live.security_problem() if root is not None else None,
                     "lockout": live.lockout_status()},
        "encryption": encryption.status(live, root, unlocked),
    })


def pin(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    problem = live.security_problem()
    if problem is not None:
        return _problem(problem)

    body = request.body or {}
    try:
        new_pin = validate_pin(body.get("pin"))
    except ValueError as error:
        return error_response(str(error), status=400)

    if live.pin_set:
        current_pin = body.get("current_pin")
        if not isinstance(current_pin, str) or not current_pin:
            return error_response("the current PIN is required to change it", status=401)
        refused = _begin(request, live)
        if refused is not None:
            return refused
        if not live.verify_pin(current_pin):
            return error_response("the current PIN is incorrect", status=401)
        live.record_success(request.token)

    try:
        live.set_pin(new_pin)
    except encryption.KeyProblem as problem:
        return _problem(problem.code)
    return json_response({"pin_set": True})


def unlock(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)

    live = runtime(request.satellite)
    if live.configured_root is None:
        return error_response("no Locked Folder location is configured yet", status=400)
    problem = live.security_problem()
    if problem is not None:
        return _problem(problem)
    if not live.pin_set:
        return error_response("no PIN has been set yet - configure one from this page first", status=400)

    body = request.body or {}
    pin_value = body.get("pin")
    if not isinstance(pin_value, str) or not pin_value:
        return error_response("'pin' must be a non-empty string", status=400)

    refused = _begin(request, live)
    if refused is not None:
        return refused

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
    PIN already set keeps working once a new location is configured. An
    encrypted vault keeps its keyring, so linking the folder again opens it.
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
    busy = _require_idle(live)
    if busy is not None:
        return busy

    configuration.update(request.engine, request.satellite, "locked_folder_path", "")
    return json_response({"delinked": True})


# ---------- the vault as media ----------

def media(request):
    """GET media -> every file in the vault; GET media/file?path=... -> one file,
    decrypted as it is sent when it is encrypted (Range requests included)."""
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    live = runtime(request.satellite)
    refused = _require_unlocked(request, live)
    if refused is not None:
        return refused
    root = live.configured_root
    if not root.is_dir():
        return error_response("the Locked Folder directory is missing", status=404)

    try:
        if not request.path:
            return json_response(vault.list_vault(live, root))
        if request.path in (("thumbnail",), ("duration",)):
            return _thumbnail(live, root, request.query.get("path"), duration=request.path == ("duration",))
        if request.path != ("file",):
            return error_response("unknown endpoint", status=404)

        relative = request.query.get("path")
        download = request.query.get("download") == "1"
        if encryption.Store.is_object_path(relative):
            store = encryption.Store.open(live, root)
            if store is None:
                return error_response("no such file in the Locked Folder", status=404)
            opened = store.open_file(relative)
            name = vault._safe_name(opened.metadata.get("name"))
            content_type = vault.MEDIA_TYPES.get(_suffix(name), (None, "application/octet-stream"))[1]
            # never cached by the browser, so nothing private outlives the unlock on disk
            return stream_response(opened, content_type, cache="private, no-store",
                                   download_name=name if download else None)

        target = vault.resolve_item(root, relative)
    except encryption.KeyProblem as problem:
        return _problem(problem.code)
    except (vault.VaultError, encryption.EncryptionError) as error:
        return error_response(str(error), status=error.status)
    content_type = vault.MEDIA_TYPES.get(target.suffix.lower(), (None, "application/octet-stream"))[1]
    return file_response(target, content_type, cache="private, no-store",
                         download_name=target.name if download else None)


def _thumbnail(live, root, relative, duration=False):
    """GET media/thumbnail?path=... -> a video's poster frame, rendered in
    memory and never stored on disk or in a browser cache (see thumbnails.py).
    media/duration?path=... -> {"duration": seconds} from the same cached
    render. 404 when there is nothing to give (not a video, no ffmpeg,
    unreadable)."""
    store = None
    if encryption.Store.is_object_path(relative):
        store = encryption.Store.open(live, root)
        if store is None:
            return error_response("no such file in the Locked Folder", status=404)
        source = store.object_path(relative)
    else:
        source = vault.resolve_item(root, relative)
    stat = source.stat()
    key = (relative, stat.st_size, stat.st_mtime_ns)
    binary = thumbnails.ffmpeg()

    entry = live.thumbnails.get(key)
    if entry is None or not entry.usable(binary):
        entry = None
        if binary:
            entry = _render_thumbnail(live, store, relative, source, binary)
            live.thumbnails.put(key, entry)
    if entry is None or entry.data is None:
        return error_response("no thumbnail is available for this file", status=404)
    if duration:
        return json_response({"duration": entry.duration})
    return stream_response(thumbnails.MemoryImage(entry.data), "image/jpeg", cache="private, no-store")


def _render_thumbnail(live, store, relative, source, binary):
    """A thumbnails.Entry for one vault file (a failed one when it is not a
    video or can't be rendered). An encrypted video is decrypted into the
    vault's tmp folder for the length of the render and always removed again."""
    if store is None:
        if vault.MEDIA_TYPES.get(source.suffix.lower(), ("file",))[0] != "video":
            return thumbnails.Entry(None, None, binary)
        return thumbnails.make(source, binary)

    with store.open_file(relative) as opened:
        name = vault._safe_name(opened.metadata.get("name"))
    if vault.MEDIA_TYPES.get(_suffix(name), ("file",))[0] != "video":
        return thumbnails.Entry(None, None, binary)
    store.clear_staging(older_than=encryption.STAGING_GRACE_SECONDS)  # leftovers of a killed process
    staging, _ = store.decrypt_to_staging(relative)
    try:
        return thumbnails.make(staging, binary)
    finally:
        staging.unlink(missing_ok=True)


def _suffix(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def _vault_action(request, action):
    """Runs a vault-changing action for an unlocked session, translating every
    failure into a response."""
    live = runtime(request.satellite)
    refused = _require_unlocked(request, live) or _require_idle(live)
    if refused is not None:
        return refused
    if not live.configured_root.is_dir():
        return error_response("the Locked Folder directory is missing", status=404)
    try:
        return action(live, live.configured_root)
    except encryption.KeyProblem as problem:
        return _problem(problem.code)
    except (vault.VaultError, encryption.EncryptionError) as error:
        return error_response(str(error), status=error.status)
    except OSError as error:
        return error_response(f"the Locked Folder could not be changed ({error.strerror or type(error).__name__})",
                              status=507 if getattr(error, "errno", None) == 28 else 500)


def upload(request):
    """POST upload?name=...&folder=... with the file as the raw body."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    return _vault_action(request, lambda live, root: json_response(
        vault.upload(live, root, request.raw, request.query.get("name"), request.query.get("folder"))))


def delete(request):
    """POST delete {paths: [...]} - permanently, files only."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    def action(live, root):
        result = vault.delete(live, root, (request.body or {}).get("paths"))
        return json_response(result, status=200 if result["deleted"] or not result["failed"] else 409)
    return _vault_action(request, action)


def move_in(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    def action(live, root):
        result = vault.move_in(request.engine, live, root, (request.body or {}).get("photo_ids"))
        return json_response(result, status=200 if result["moved"] or not result["failed"] else 409)
    return _vault_action(request, action)


def move_out(request):
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)

    def action(live, root):
        result = vault.move_out(request.engine, live, root, (request.body or {}).get("paths"))
        return json_response(result, status=200 if result["moved"] or not result["failed"] else 409)
    return _vault_action(request, action)


# ---------- encryption ----------

def encryption_route(request):
    """GET  encryption                       -> encryption details (unlocked)
    POST encryption/start   {recovery_key: bool} -> starts encrypting; the
                                               recovery key, if one was made now
    POST encryption/undo    {run}             -> puts a run's originals back
    POST encryption/discard {run, pin}        -> deletes a run's backup
    POST encryption/recovery_key {pin, remove?} -> a new recovery key, or none

    Everything here needs this session unlocked; deleting a backup and
    replacing the recovery key need the PIN again on top."""
    live = runtime(request.satellite)
    refused = _require_unlocked(request, live)
    if refused is not None:
        return refused
    root = live.configured_root

    if request.method == "GET" and not request.path:
        return json_response(encryption.status(live, root, True))
    if request.method != "POST" or len(request.path) != 1:
        return error_response("unknown endpoint", status=404)
    action = request.path[0]
    body = request.body or {}

    problem = live.security_problem()
    if problem is not None:
        return _problem(problem)
    if not root.is_dir():
        return error_response("the Locked Folder directory is missing", status=404)

    try:
        if action == "start":
            return _start_encryption(live, root, body)
        busy = _require_idle(live)
        if busy is not None:
            return busy
        if action == "undo":
            return json_response(encryption.undo_run(live, root, str(body.get("run") or "")))
        if action in ("discard", "recovery_key"):
            refused = _confirm_pin(request, live, body.get("pin"))
            if refused is not None:
                return refused
            if action == "discard":
                return json_response(encryption.discard_backup(live, root, str(body.get("run") or "")))
            text = encryption.replace_recovery_key(live, root, remove=body.get("remove") is True)
            return json_response({"recovery_key": text})
    except encryption.KeyProblem as error:
        return _problem(error.code)
    except encryption.EncryptionError as error:
        return error_response(str(error), status=error.status)
    return error_response("unknown endpoint", status=404)


def _confirm_pin(request, live, pin_value):
    if not isinstance(pin_value, str) or not pin_value:
        return error_response("enter the PIN to confirm", status=401)
    refused = _begin(request, live)
    if refused is not None:
        return refused
    if not live.verify_pin(pin_value):
        return error_response("incorrect PIN", status=401)
    live.record_success(request.token)
    return None


def _start_encryption(live, root, body):
    with _migration_lock:
        if live.migration is not None and live.migration.running:
            return error_response("the Locked Folder is already being encrypted", status=409)
        recovery = None
        if not encryption.is_encrypted(root):
            if not live.pin_set:
                return error_response("set a PIN before encrypting the Locked Folder", status=400)
            if not isinstance(body.get("recovery_key"), bool):
                return error_response("'recovery_key' must say whether to create a recovery key", status=400)
            recovery = encryption.set_up(live, root, body["recovery_key"])
        else:
            encryption.vault_key(live, root)  # raises KeyProblem before anything starts
        progress = encryption.Progress()
        progress.running = True
        live.migration = progress

    def work():
        try:
            result = encryption.encrypt_vault(live, root, progress)
            progress.failed = result["failed"]
        except encryption.EncryptionError as error:
            progress.error = str(error)
        except encryption.KeyProblem as error:
            progress.error = PROBLEMS.get(error.code, (str(error),))[0]
        except Exception as error:
            progress.error = "encryption stopped unexpectedly - every original is still in place; resume to retry"
            print(f"[WARNING]: encrypting the Locked Folder failed ({type(error).__name__}).")
        finally:
            progress.running = False

    threading.Thread(target=work, name="locked-folder-encryption", daemon=True).start()
    # the recovery key is in this response and nowhere else, ever
    return json_response({"started": True, "recovery_key": recovery})


def recover(request):
    """POST recover {recovery_key, pin} - sets a new PIN with the recovery
    key. Removes every biometric enrollment and unlock, like a PIN change."""
    if request.method != "POST":
        return error_response("only POST is supported here", status=405)
    if not request.token:
        return error_response("authentication required", status=401)
    live = runtime(request.satellite)
    root = live.configured_root
    if root is None:
        return error_response("no Locked Folder location is configured yet", status=400)

    body = request.body or {}
    try:
        new_pin = validate_pin(body.get("pin"))
    except ValueError as error:
        return error_response(str(error), status=400)
    try:
        wait = encryption.recover(live, root, body.get("recovery_key"), new_pin, request.token, _limits(request))
    except SecurityStateError:
        return error_response("the Locked Folder could not record this attempt, so it was refused", status=503)
    except crypto.WrongKey:
        return error_response("that recovery key doesn't open this Locked Folder", status=401)
    except encryption.KeyProblem as problem:
        return _problem(problem.code)
    except encryption.EncryptionError as error:
        return error_response(str(error), status=error.status)
    if wait:
        return _too_many(wait)
    return json_response({"pin_set": True})


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
    problem = live.security_problem()
    if problem is not None:
        return _problem(problem)
    if not live.pin_set:
        return error_response("set a PIN before turning on biometric unlock", status=400)

    if action == "enroll":
        pin_value = body.get("pin")
        if not isinstance(pin_value, str) or not pin_value:
            return error_response("'pin' is required to turn on biometric unlock", status=400)
        try:
            public_key = _decode(body.get("public_key"))
        except ValueError:
            return error_response("'public_key' must be a base64 RSA public key", status=400)
        refused = _begin(request, live)
        if refused is not None:
            return refused
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
    refused = _begin(request, live)
    if refused is not None:
        return refused
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
