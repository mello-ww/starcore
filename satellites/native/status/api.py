"""Status routes, served under /api/satellites/status/ (signed-in sessions only, like every
satellite route). See docs/satellites/status.md.

    metrics       the latest snapshot: health, CPU, memory, storage, network, system, services
    history       ?period=1h|24h|7d|30d [&series=cpu,memory] [&points=N]
    diagnostics   sampler, history file and support details
    view          the same snapshot shaped for display: what ui.json binds to (see view.py)
    view/diagnostics   /diagnostics shaped for display
"""

from starcore.api.response import error_response, json_response

from . import view as display
from .history import PERIODS, SERIES
from .monitor import monitor_for

MAX_POINTS = 2000


def routes() -> dict:
    return {"metrics": metrics, "history": history, "diagnostics": diagnostics, "view": view}


def _only_get(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)
    return None


def metrics(request):
    return _only_get(request) or json_response(monitor_for(request.engine, request.satellite).snapshot())


def history(request):
    refused = _only_get(request)
    if refused:
        return refused
    query = request.query or {}
    period = query.get("period", "24h")
    if period not in PERIODS:
        return error_response(f"period must be one of {', '.join(PERIODS)}", status=400)
    series = None
    if query.get("series"):
        series = [name.strip() for name in str(query["series"]).split(",") if name.strip()]
        unknown = [name for name in series if name not in SERIES]
        if unknown:
            return error_response(f"unknown series {', '.join(unknown)} (known: {', '.join(SERIES)})", status=400)
    points = None
    if query.get("points"):
        try:
            points = int(query["points"])
        except ValueError:
            return error_response("points must be a whole number", status=400)
        if not 10 <= points <= MAX_POINTS:
            return error_response(f"points must be between 10 and {MAX_POINTS}", status=400)
    return json_response(monitor_for(request.engine, request.satellite).history_query(period, series, points))


def diagnostics(request):
    return _only_get(request) or json_response(monitor_for(request.engine, request.satellite).diagnostics())


def view(request):
    refused = _only_get(request)
    if refused:
        return refused
    monitor = monitor_for(request.engine, request.satellite)
    path = tuple(request.path or ())
    if not path:
        return json_response(display.describe(monitor.snapshot()))
    if path == ("diagnostics",):
        return json_response(display.diagnostics(monitor.diagnostics()))
    return error_response("unknown view (known: view, view/diagnostics)", status=404)
