"""Showcase - the routes behind ui.json.

Ordinary Satellite routes: JSON in, JSON out, nothing UI-specific. The
interface itself is entirely ui.json, rendered by each client. State lives in
memory and resets when StarCore restarts or this Satellite is reloaded.
"""

from itertools import count
from threading import Lock
import time

from starcore.api.response import error_response, json_response

SIZES = {"small": 2 * 1024, "medium": 5 * 1024 * 1024, "large": 2 * 1024 * 1024 * 1024}
STARTED = time.time()

_lock = Lock()
_ids = count(1)
_state = {}


def _reset():
    _state.clear()
    _state.update({"enabled": True, "level": 40, "counter": 0, "selected": None,
                   "last_action": "Started", "items": {}})


_reset()


def routes() -> dict:
    return {
        "summary": summary,
        "settings": settings,
        "counter": counter,
        "reset": reset,
        "items": items,
        "selection": selection,
    }


def summary(request):
    with _lock:
        counter_value = _state["counter"]
        return json_response({
            "enabled": _state["enabled"],
            "disabled": not _state["enabled"],
            "level": _state["level"],
            "uptime": round(time.time() - STARTED),
            "counter": counter_value,
            "counter_tone": "warn" if counter_value >= 10 else "neutral",
            "selected": _state["selected"],
            "last_action": _state["last_action"],
            "diagnostics": f"{len(_state['items'])} items in memory - contract starcore.ui/1.0",
        })


def settings(request):
    if request.method != "POST":
        return error_response("POST a setting", status=405)
    body = request.body or {}
    with _lock:
        if "enabled" in body:
            if not isinstance(body["enabled"], bool):
                return error_response("enabled must be true or false", status=400)
            _state["enabled"] = body["enabled"]
            _state["last_action"] = f"Enabled turned {'on' if body['enabled'] else 'off'}"
        if "level" in body:
            level = body["level"]
            if isinstance(level, bool) or not isinstance(level, (int, float)) or not 0 <= level <= 100:
                return error_response("level must be a number from 0 to 100", status=400)
            _state["level"] = level
            _state["last_action"] = f"Level set to {level:g}%"
    return json_response({"message": _state["last_action"]})


def counter(request):
    if request.method != "POST" or request.path != ("increment",):
        return error_response("POST counter/increment", status=405)
    with _lock:
        if not _state["enabled"]:
            # the button is hidden while disabled, but the route enforces it
            # anyway - a document never decides what's allowed
            return error_response("Showcase is turned off", status=409)
        _state["counter"] += 1
        _state["last_action"] = f"Counter increased to {_state['counter']}"
    return json_response({"message": _state["last_action"]})


def reset(request):
    if request.method != "POST":
        return error_response("POST to reset", status=405)
    with _lock:
        _reset()
        _state["last_action"] = "Everything reset"
    return json_response({"message": "Everything reset"})


def selection(request):
    if request.method != "POST":
        return error_response("POST a path", status=405)
    path = (request.body or {}).get("path")
    if not isinstance(path, str) or not path:
        return error_response("path must be a non-empty string", status=400)
    with _lock:
        _state["selected"] = path
        _state["last_action"] = "Folder chosen"
    return json_response({"message": f"Chose {path}"})


def _describe(item):
    return {**item, "icon": "star" if item["pinned"] else "file",
            "note": f"{item['copies']} {'copy' if item['copies'] == 1 else 'copies'}, priority {item['priority']}"}


def items(request):
    """items (GET list, POST add), items/<id> (GET), items/<id>/priority
    and items/<id>/delete (POST)."""
    with _lock:
        if not request.path:
            if request.method == "GET":
                listed = sorted(_state["items"].values(), key=lambda item: (not item["pinned"], item["id"]))
                return json_response({"items": [_describe(item) for item in listed]})
            return _add(request.body or {})

        item = _state["items"].get(request.path[0])
        if item is None:
            return error_response("no such item", status=404)
        if len(request.path) == 1 and request.method == "GET":
            return json_response(_describe(item))
        if request.path[1:] == ("priority",) and request.method == "POST":
            priority = (request.body or {}).get("priority")
            if isinstance(priority, bool) or not isinstance(priority, (int, float)) or not 1 <= priority <= 5:
                return error_response("priority must be from 1 to 5", status=400)
            item["priority"] = int(priority)
            return json_response({"message": f"Priority set to {item['priority']}"})
        if request.path[1:] == ("delete",) and request.method == "POST":
            del _state["items"][item["id"]]
            _state["last_action"] = f"Deleted {item['title']}"
            return json_response({"message": f"Deleted {item['title']}"})
    return error_response("unknown item action", status=404)


def _add(body):
    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        return error_response("a title is required", status=400)
    size = body.get("size", "small")
    if size not in SIZES:
        return error_response("size must be small, medium or large", status=400)
    copies = body.get("copies", 1)
    if isinstance(copies, bool) or not isinstance(copies, (int, float)) or not 1 <= copies <= 99:
        return error_response("copies must be from 1 to 99", status=400)
    item = {"id": str(next(_ids)), "title": title.strip()[:80], "size": SIZES[size], "copies": int(copies),
            "pinned": bool(body.get("pinned", False)), "priority": 3}
    _state["items"][item["id"]] = item
    _state["last_action"] = f"Added {item['title']}"
    return json_response({"id": item["id"], "message": f"Added {item['title']}"})
