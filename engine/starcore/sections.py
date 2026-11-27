"""Sections: the Satellites another one hosts.

A Satellite whose manifest says `section_of = "<host>"` is opened from inside its host rather
than on its own - a host's page shows it as one of its own places, and a host's shared
interface opens it with the `section` action (UI contract 1.2). A host asks the Engine which
Satellites it hosts, so its code never names them: their names, titles and icons come from the
registry, each from the hosted Satellite's own manifest and document.

Nothing here names a Satellite.
See docs/reference/ui-contract.md, "Actions" (the section action).
"""

import re

DEFAULT_ICON = "folder"

# "SomeName" -> "Some Name", for a section without a document title
_WORD_BREAK = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def hosted(engine, host: str) -> list:
    """[{name, title, icon, description}] of every enabled Satellite whose manifest names `host`
    as its host, in the registry's order. `title` is its document's title (ui.json) when it has a
    valid one, else its name with spaces between words; `icon` its manifest's `icon_name`."""
    found = []
    for satellite in engine.registry.all():
        manifest = satellite.manifest
        if manifest.section_of != host or not satellite.enabled or manifest.name == host:
            continue
        found.append({
            "name": manifest.name,
            "title": _title(satellite),
            "icon": manifest.icon_name or DEFAULT_ICON,
            "description": manifest.description or "",
        })
    return found


def _title(satellite) -> str:
    ui = getattr(satellite, "ui", None)
    document = getattr(ui, "document", None) if ui is not None and not getattr(ui, "error", None) else None
    title = document.get("title") if isinstance(document, dict) else None
    if isinstance(title, str) and title.strip():
        return title.strip()
    return _WORD_BREAK.sub(" ", satellite.manifest.name)
