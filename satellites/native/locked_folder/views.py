"""What the Locked Folder's shared interface (ui.json) reads: the vault shaped for the shared
blocks (a media-grid and its viewer), and a setup summary for a vault that can't be opened yet.

Only views: they read, never change anything, and every change the document makes goes to the
Satellite's existing routes (upload, delete, move_out). The gallery is served to a session that
has the vault open, as every other vault route (api.py); the setup summary to anyone signed in,
so it says what is missing and never where the vault is. See docs/satellites/locked_folder.md,
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


def setup(live, configured: bool, problem) -> dict:
    """GET setup -> {title, message, problem}: why the vault can't be opened yet, in words the
    person can act on - never its location, its PIN or anything it holds."""
    if not configured:
        return {"title": "Not set up yet",
                "message": "Choose where the Locked Folder keeps its files and set a PIN in its own "
                           "screens: Albums in Photos, then Locked Folder.",
                "problem": None}
    if problem is not None:
        return {"title": "Can't be opened",
                "message": "The Locked Folder's security state can't be checked on this server, so it "
                           "stays locked. Use the recovery key from its own screens, or ask whoever runs "
                           "the server to look at it.",
                "problem": problem}
    if not live.pin_set:
        return {"title": "No PIN yet",
                "message": "Set a PIN in the Locked Folder's own screens (Albums in Photos, then Locked "
                           "Folder). Until then nothing in it is protected.",
                "problem": None}
    return {"title": "Ready", "message": "The Locked Folder is set up. Unlock it to see what it holds.",
            "problem": None}


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
