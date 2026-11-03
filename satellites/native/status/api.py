"""Status routes, served under /api/satellites/status/ (signed-in sessions only, like every
satellite route). See docs/satellites/status.md.

    metrics       the latest snapshot: health, CPU, memory, storage, network, system, services
    history       ?period=1h|24h|7d|30d [&series=cpu,memory] [&points=N]
    diagnostics   sampler, history file and support details
    mobile        the generic declarative screen for clients without a native one
"""

from starcore.api.response import error_response, json_response

from .history import PERIODS, SERIES
from .monitor import monitor_for

MAX_POINTS = 2000


def routes() -> dict:
    return {"metrics": metrics, "history": history, "diagnostics": diagnostics, "mobile": mobile}


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


def mobile(request):
    refused = _only_get(request)
    if refused:
        return refused
    summary = monitor_for(request.engine, request.satellite).summary()

    def number(value, unit="%"):
        return "-" if value is None else f"{value:.0f}{unit}"

    items = [
        {"type": "status", "label": "Health", "value": summary["health"].capitalize()},
        {"type": "status", "label": "CPU", "value": number(summary["cpu_percent"])},
        {"type": "status", "label": "Memory", "value": number(summary["memory_percent"])},
        {"type": "status", "label": "Satellites",
         "value": f"{summary['satellites_online']}/{summary['satellites_total']} online"},
        # technical details: shown by the app in Developer Mode only (a display hint, not a permission)
        {"type": "status", "label": "Platform", "value": str(summary.get("platform") or "-"), "developer": True},
        {"type": "status", "label": "Python", "value": str(summary.get("python") or "-"), "developer": True},
    ]
    sections = [{"type": "card", "items": items}]
    if summary["warnings"]:
        sections.append({"type": "card", "title": "Warnings",
                         "items": [{"type": "list", "items": [{"title": title} for title in summary["warnings"]]}]})
    return json_response({"screen": {"title": request.satellite.manifest.name, "sections": sections}})
