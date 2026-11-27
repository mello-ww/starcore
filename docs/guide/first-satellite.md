# Your first Satellite

A Satellite is a folder. This guide builds one, **Hello**, out of three small files: a
manifest, a route and an interface. It then appears in Mission Control and in the Android
app, without a line of client code.

You need a StarCore checkout that runs locally (see [Deployment](deployment.md)).

## 1. The folder and its manifest

Native Satellites live in `satellites/native/`, one folder each. Create
`satellites/native/hello/satellite.toml`:

```toml
name = "Hello"
version = "0.1.0"
author = "You"
description = "Counts how many times it was greeted."
icon_name = "star"
```

`icon_name` picks one of the shared icons every client draws (the list is `icons` in
`contracts/ui/vocabulary.json`). A Satellite can also ship icons of its own: see
"Status and icon" in [How Satellites work](../satellites/README.md).

## 2. A route

A Satellite answers requests through an `api.py` whose `routes()` maps route names to
handlers. Create `satellites/native/hello/api.py`:

```python
from threading import Lock

from starcore.api.response import error_response, json_response

_lock = Lock()
_greetings = 0


def routes() -> dict:
    return {"summary": summary, "greet": greet}


def summary(request):
    with _lock:
        return json_response({
            "greetings": _greetings,
            "message": "Nobody said hello yet." if _greetings == 0 else "Hello back!",
        })


def greet(request):
    global _greetings
    if request.method != "POST":
        return error_response("POST to greet", status=405)
    with _lock:
        _greetings += 1
    return json_response({"message": "Hello!"})
```

Each route is served below the Satellite: `summary` is
`GET /api/satellites/hello/summary`. Routes are ordinary JSON in, JSON out, protected by the
same sign-in as the rest of the API; nothing in them is specific to an interface.

## 3. An interface

A Satellite describes its interface in a `ui.json` beside its manifest; each client draws
it with its own shared components. Create `satellites/native/hello/ui.json`:

```json
{
  "contract": "starcore.ui/1.0",
  "title": "Hello",
  "entry": "home",
  "pages": {
    "home": {
      "title": "Hello",
      "source": {"route": "summary", "refresh": 10},
      "blocks": [
        {"type": "card", "title": "Greetings", "blocks": [
          {"type": "field", "label": "Received", "value": "$.greetings", "format": "integer"},
          {"type": "text", "text": "$.message", "style": "caption"},
          {"type": "button", "label": "Say hello", "style": "primary",
           "action": {"route": "greet", "then": "refresh"}}
        ]}
      ]
    }
  }
}
```

The page loads its `source` route and binds its blocks to the answer: `$.greetings` is the
`greetings` key of what `summary` returned. The button posts to `greet`, then reloads the
page.

## 4. Try it

Start StarCore (`uv run python -m starcore` in `engine/`) and open Mission Control. Hello is
listed with the other Satellites; open it and press **Say hello**. The Android app shows the
same page, drawn natively, the next time it refreshes its Satellites.

After an edit, reload the Satellite without restarting StarCore, from the CLI or with its
reload button in Mission Control's Developer Mode:

```
satellites reload hello
```

If the Engine refuses the `ui.json`, it reports why when the Satellite loads (the Satellite's
`ui.error` in the API).

## Where to go next

- [UI contract](../reference/ui-contract.md): every block, action and format a `ui.json`
  can use. The example Satellite in `examples/satellites/native/showcase/` uses all the
  blocks of contract 1.0.
- [How Satellites work](../satellites/README.md): publishing state, a background service,
  configuration, CLI commands and capabilities other Satellites can use.
- [API](../reference/api.md): the Engine's own endpoints and how authentication works.
