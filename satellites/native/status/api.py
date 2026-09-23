"""Mobile UI route for the Status satellite - a worked example of "Exposing
a mobile interface" (see docs/satellites.md). Deliberately reuses the exact
same data state.py already publishes to Mission Control - this is not a
second source of truth for what Status reports, just a different rendering
of it for the mobile app's generic declarative-UI screen.
"""

from starcore.api.response import error_response, json_response

from . import state as state_module


def routes() -> dict:
    return {"mobile": mobile}


def mobile(request):
    if request.method != "GET":
        return error_response("only GET is supported here", status=405)

    data = state_module.state(request.engine, request.satellite)

    return json_response({
        "screen": {
            "title": request.satellite.manifest.name,
            "sections": [
                {
                    "type": "card",
                    "items": [
                        {"type": "status", "label": "Platform", "value": str(data.get("platform", "-"))},
                        {"type": "status", "label": "Python", "value": str(data.get("python", "-"))},
                        {"type": "status", "label": "Refresh rate", "value": f"{data.get('refresh_rate', '-')}s"},
                    ],
                },
            ],
        },
    })
