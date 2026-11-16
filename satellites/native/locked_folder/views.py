"""What the Locked Folder's shared interface (ui.json) reads: the vault shaped for the shared
blocks (a media-grid and its viewer), a setup summary for a vault that can't be opened yet, and
its settings (the PIN, encryption, the recovery key, backups, the location).

Only views: they read, never change anything, and every change the document makes goes to the
Satellite's existing routes (upload, delete, move_out, configuration, pin, recover, encryption,
delink), each needing what it always has. The gallery and the settings are served to a session
that has the vault open, as every other vault route (api.py); the setup summary to anyone signed
in, so it says what is missing and never where the vault is. See docs/satellites/locked_folder.md,
"Shared interface".
"""

from datetime import datetime

from . import vault

PAGE_SIZE = 120
MAX_PAGE_SIZE = 500

MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")

# a vault item's media_type, as a media-grid's kind, and the media route that gives its tile:
# the file itself for a photo, the poster frame rendered in memory for a video, none otherwise
KINDS = {"photo": "image", "video": "video"}
PREVIEWS = {"image": "file", "video": "thumbnail"}
# drawn when a tile has no image: a file that isn't a picture, a video without a poster
ICONS = {None: "file", "video": "play"}


def gallery(live, root, photos_available: bool, limit=None, cursor=None) -> dict:
    """GET gallery?limit=&cursor= -> {items, next, summary, truncated, photos_available}: the
    vault newest first, a page at a time (the cursor is the position of the next page)."""
    listed = vault.list_vault(live, root)
    items = listed["items"]
    size = _limit(limit)
    start = _position(cursor, len(items))
    shown = items[start:start + size]
    following = start + size
    return {
        "items": [tile(item, photos_available) for item in shown],
        "next": str(following) if following < len(items) else None,
        "summary": _summary(items, listed["truncated"]),
        "truncated": listed["truncated"],
        "photos_available": photos_available,
    }


def tile(item: dict, photos_available: bool) -> dict:
    """One vault item with what the grid and the viewer bind: its kind, its tile's media route
    (`preview`, a sub-route of media), an icon without one, its month and whether it can go
    back to Photos (a photo or a video, while a library is there)."""
    kind = KINDS.get(item.get("media_type"))
    return {
        **item,
        "kind": kind,
        "preview": PREVIEWS.get(kind),
        "icon": ICONS.get(kind),
        "group": _month(item.get("modified")),
        "movable": bool(photos_available and kind is not None),
    }


# why a configured vault can't be opened (status.security.problem), in words the person can act on
PROBLEMS = {
    "pin_unreadable": ("The PIN can't be read",
                       "The stored PIN file on the server is damaged, so the Locked Folder stays locked."),
    "pin_tampered": ("The PIN was changed outside StarCore",
                     "The PIN record on the server doesn't match this Locked Folder, so it stays locked."),
    "key_unavailable": ("This server can't open the Locked Folder",
                        "The encryption key for these files isn't on this server - it may be a new server, "
                        "a restored backup, or a different Windows account."),
    "keyring_damaged": ("The Locked Folder's keyring is missing",
                        "The file that holds the encryption key is missing or damaged. Restore it from a "
                        "backup of the Locked Folder's folder."),
    "encryption_unavailable": ("Encryption support isn't installed",
                               "The Locked Folder is encrypted, but StarCore's encryption package isn't "
                               "installed on this server. Install the engine's 'encryption' extra and "
                               "restart StarCore."),
}
# the problems a recovery key gets past, by setting a new PIN
RECOVERABLE = {"pin_unreadable", "pin_tampered", "key_unavailable"}


def setup(live, configured: bool, problem, recovery_key: bool = False, encrypted: bool = False,
          forgot: bool = False) -> dict:
    """GET setup -> {title, message, problem, needs_location, needs_pin, recoverable}: why the
    vault can't be opened yet, in words the person can act on, and which step the setup page
    offers (a location, a first PIN, a new PIN with the recovery key) - never its location, its
    PIN or anything it holds. With `forgot` (GET setup?forgot=1, the forgotten-PIN page), for a
    vault that is ready: the way out of a forgotten PIN, the recovery key when there is one,
    otherwise what can still be done and by whom."""
    page = {"problem": None, "needs_location": False, "needs_pin": False, "recoverable": False}
    if not configured:
        return {**page, "title": "Not set up yet", "needs_location": True,
                "message": "Choose a folder on this server to hold private photos and files. They stay "
                           "hidden from Photos, search, albums and File Explorer until you unlock them "
                           "with your PIN."}
    if problem is not None:
        title, text = PROBLEMS.get(problem, ("Can't be opened", "The Locked Folder can't be opened on this "
                                                               "server, so it stays locked."))
        recoverable = bool(recovery_key) and problem in RECOVERABLE
        if recoverable:
            advice = "Enter your recovery key to set a new PIN."
        elif problem == "key_unavailable":
            advice = ("No recovery key was set up, so without this server's original key its files can't "
                      "be decrypted.")
        elif problem == "pin_unreadable":
            advice = "Whoever runs the server needs to restore pin.json in StarCore's data folder from a backup."
        else:
            advice = "Ask whoever runs the server to look at it."
        return {**page, "title": title, "message": f"{text} {advice}", "problem": problem,
                "recoverable": recoverable}
    if not live.pin_set:
        return {**page, "title": "No PIN yet", "needs_pin": True,
                "message": "Create a PIN of 4 to 12 digits. You'll need it every time you open the Locked "
                           "Folder; until then nothing in it is protected. A forgotten PIN can only be reset "
                           "with a recovery key, which you can create when you encrypt it."}
    if forgot:
        if recovery_key:
            message = ("Enter your recovery key, then choose a new PIN. Phones set up to unlock with "
                       "biometrics have to be set up again.")
        elif encrypted:
            message = "No recovery key was created for this Locked Folder, so a forgotten PIN can't be reset."
        else:
            message = ("This Locked Folder isn't encrypted and has no recovery key, so its PIN can't be reset "
                       "from here. Whoever runs the StarCore server can delete pin.json from StarCore's data "
                       "folder (satellites/LockedFolder) and restart StarCore, then create a new PIN here. The "
                       "files in the folder are not touched.")
        return {**page, "title": "Forgot your PIN?", "message": message, "recoverable": bool(recovery_key)}
    return {**page, "title": "Ready", "message": "The Locked Folder is set up. Unlock it to see what it holds."}


def _originals(count) -> str:
    return f"{count} {'original' if count == 1 else 'originals'}"


def settings(live, root, info: dict) -> dict:
    """GET settings -> what the settings page shows and which of its actions apply: the location,
    the phones with biometric unlock, and encryption (`info`, encryption.py's status for an
    unlocked session) with its recovery key and backups. Never the PIN or a key."""
    state = info.get("state") or "off"
    available = bool(info.get("available"))
    unencrypted = int(info.get("unencrypted_files") or 0)
    has_key = bool(info.get("recovery_key"))
    devices = live.device_count()
    backups = [{**found, "title": f"Backup of {_originals(found.get('files') or 0)}"}
               for found in info.get("backups") or []]
    return {
        "path": str(root),
        "path_missing": not root.is_dir(),
        "biometric_devices": devices,
        "biometric_note": (f"{devices} {'phone' if devices == 1 else 'phones'} can unlock with biometrics. "
                           "Changing the PIN turns that off everywhere; a phone turns it off from its unlock "
                           "card." if devices else
                           "A phone can add fingerprint or face unlock from the StarCore app: \"Use "
                           "biometrics next time\" on its unlock card."),
        "encryption": _encryption_summary(info, state, available, unencrypted),
        "recovery": (("A recovery key is set up." if has_key else
                      "No recovery key: if this server's key is lost, or the PIN forgotten, these files "
                      "can't be recovered.") if state != "off" else None),
        # which of the page's actions apply now
        "can_encrypt": available and state == "off" and bool(live.pin_set),
        "can_resume": available and (state == "interrupted" or (state == "on" and unencrypted > 0)),
        "resume_label": "Resume encryption" if state == "interrupted" else "Encrypt remaining files",
        "can_undo": state == "interrupted" and bool(info.get("interrupted_run")),
        "interrupted_run": info.get("interrupted_run"),
        "has_recovery_key": state == "on" and has_key,
        "no_recovery_key": state == "on" and not has_key,
        "backups": backups,
        "has_backups": bool(backups),
    }


def backup(info: dict, run) -> dict | None:
    """GET settings?run= -> one backup of `info` (encryption.py's status), for its own page."""
    for found in info.get("backups") or []:
        if str(found.get("id")) == str(run):
            return {**found, "summary": f"{_originals(found.get('files') or 0)} kept unencrypted when the "
                                        "Locked Folder was encrypted."}
    return None


def _encryption_summary(info: dict, state: str, available: bool, unencrypted: int) -> str:
    if info.get("problem") in PROBLEMS:
        return PROBLEMS[info["problem"]][1]
    progress = info.get("migration") or {}
    if state == "off":
        if not available:
            return ("Files here are protected by your PIN but stored unencrypted. Encryption needs the "
                    "engine's 'encryption' extra installed on the server.")
        return ("Files here are protected by your PIN but stored unencrypted. Encrypting them (AES-256-GCM) "
                "means a copy of this folder, or a stolen disk, shows nothing. Your originals are kept as a "
                "backup until you delete them.")
    if state == "encrypting":
        done, total = progress.get("done"), progress.get("total")
        return f"Encrypting now: {done} of {total} files." if total else "Encrypting now..."
    if state == "interrupted":
        text = "Encryption started but didn't finish. Resume it, or undo it to put every original back."
        return f"{text} {progress['error']}" if progress.get("error") else text
    text = "On - files are stored encrypted with AES-256-GCM."
    if unencrypted:
        text += f" {unencrypted} {'file is' if unencrypted == 1 else 'files are'} not encrypted yet."
    return text


def _limit(value) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return PAGE_SIZE
    return max(1, min(size, MAX_PAGE_SIZE))


def _position(cursor, total: int) -> int:
    try:
        position = int(cursor)
    except (TypeError, ValueError):
        return 0
    return max(0, min(position, total))


def _month(modified):
    if not modified:
        return "Unknown date"
    try:
        moment = datetime.fromisoformat(str(modified))
    except ValueError:
        return "Unknown date"
    local = moment.astimezone() if moment.tzinfo else moment
    return f"{MONTHS[local.month - 1]} {local.year}"


def _summary(items: list, truncated: bool) -> str:
    count = len(items)
    if count == 0:
        return "Nothing here yet."
    text = f"{count} {'item' if count == 1 else 'items'}"
    if truncated:
        text += " (only the newest are shown)"
    return text
