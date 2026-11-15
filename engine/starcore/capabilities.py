"""Satellite capabilities as the Engine itself uses them: finding a capability's provider, and
resolving the references clients send.

A reference ({provider, capability, id}) comes from a client and is only a claim about an item.
Before a Satellite acts on one, it asks the Engine, which:

- finds the provider of the capability in its own registry (the first enabled Satellite that
  declares it), never from what the reference says;
- refuses a reference whose provider or capability isn't exactly that;
- asks that provider, through its `resolve` operation and with the caller's own session,
  whether the id names an item the person may act on now.

Only the provider's answer counts.

It also answers, for every Satellite, whether a path on disk is in a protected area
(`protection`, the files.protected capability): asked before a Satellite serves, lists, indexes,
renames or deletes a path, so no Satellite needs to know which one guards it.

Nothing here names a Satellite.
See docs/ui-contract.md, "Shared blocks and Satellite capabilities".
"""

import re
from typing import NamedTuple, Optional

from .api.response import Request

# at most this many references in one request (a selection's bulk limit)
MAX_REFERENCES = 500
REFERENCE_KEYS = {"provider", "capability", "id", "kind"}
ITEM_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def providers(engine, capability: str, enabled_only: bool = True) -> list:
    """[(satellite, {version, operations})] of every Satellite providing `capability`, in the
    registry's order: only the enabled ones, unless `enabled_only` is False."""
    found = []
    for satellite in engine.registry.all():
        entry = satellite.manifest.provides.get(capability)
        if entry is not None and (satellite.enabled or not enabled_only):
            found.append((satellite, entry))
    return found


def provider(engine, capability: str):
    """(satellite, {version, operations}) of the first enabled Satellite providing
    `capability`, or (None, None)."""
    found = providers(engine, capability)
    return found[0] if found else (None, None)


def call(engine, capability: str, operation: str, path: tuple = (), query: dict = None, token: str = ""):
    """Runs a GET operation of the capability's provider in-process, with the caller's session,
    as if the client had asked it. The Response, or None when there is no provider, it lacks the
    operation, or it failed."""
    satellite, entry = provider(engine, capability)
    if satellite is None:
        return None
    return _run(engine, satellite, entry, capability, operation, path, query, token)


def _run(engine, satellite, entry, capability, operation, path=(), query=None, token=""):
    """One provider's GET operation, in-process: its Response, or None when it lacks the
    operation or failed."""
    if operation not in entry["operations"]:
        return None
    route = entry["operations"][operation].split("/")
    handler = satellite.routes.get(route[0])
    if handler is None:
        return None
    request = Request(engine, satellite, "GET", tuple(route[1:]) + tuple(path), dict(query or {}), token=token)
    try:
        return handler(request)
    except Exception as error:
        print(f"[WARNING]: '{capability}' {operation} of '{satellite.manifest.name}' failed ({type(error).__name__}).")
        return None


# ---------- protected areas on disk (files.protected) ----------

PROTECTED_FILES = "files.protected"
UNCHECKED = "this location can't be checked right now, so it stays closed"


class Protection(NamedTuple):
    """protected: the path is in an area a provider guards (with `tree`, or contains one).
    open: this session may reach it through other Satellites now (always True when not
    protected). message: the provider's words for a refusal, None when open."""
    protected: bool
    open: bool
    message: Optional[str] = None


UNPROTECTED = Protection(False, True, None)


def protection(engine, path, token: str = "", tree: bool = False) -> Protection:
    """Whether `path` (absolute) is in a protected area, and whether the session `token` may
    reach it now, as every files.protected provider answers.

    Every provider is asked, enabled or not: disabling one needs no PIN, so it must not open
    what it guards. The path is protected when any provider says so, and open only when each
    of those says it is. A provider that fails, or answers anything but the protocol, keeps
    the path closed. `tree` also counts a folder that contains a protected area - for the
    operations that act on a whole tree (rename, delete, a scan)."""
    found = providers(engine, PROTECTED_FILES, enabled_only=False)
    if not found:
        return UNPROTECTED
    query = {"path": str(path)}
    if tree:
        query["tree"] = "1"

    protected, refusal = False, None
    for satellite, entry in found:
        answer = _protection_answer(engine, satellite, entry, query, token)
        if answer.protected:
            protected = True
            if not answer.open and refusal is None:
                refusal = answer.message or UNCHECKED
    if not protected:
        return UNPROTECTED
    return Protection(True, refusal is None, refusal)


def _protection_answer(engine, satellite, entry, query: dict, token: str) -> Protection:
    response = _run(engine, satellite, entry, PROTECTED_FILES, "check", query=query, token=token)
    payload = getattr(response, "payload", None)
    if (response is None or response.status != 200 or not isinstance(payload, dict)
            or not isinstance(payload.get("protected"), bool) or not isinstance(payload.get("open"), bool)):
        print(f"[WARNING]: '{satellite.manifest.name}' could not say whether a path is protected; "
              "it stays closed.")
        return Protection(True, False, UNCHECKED)
    if not payload["protected"]:
        return UNPROTECTED
    message = payload.get("message")
    return Protection(True, payload["open"], None if payload["open"] else
                      (message if isinstance(message, str) and message else UNCHECKED))


class ReferenceProblem(ValueError):
    """A request's references as a whole can't be used (wrong shape, too many, no provider)."""


def resolve_references(engine, capability: str, references, token: str = "") -> tuple:
    """(resolved, refused) for a list of references to `capability`'s items.

    resolved: [{provider, capability, id, kind}] as the provider answered, in order, without
    duplicates. refused: [{index, reason}] for each reference that isn't one. Raises
    ReferenceProblem when the list itself is unusable. A caller that must not act on part of a
    request treats any refusal as refusing all of it."""
    if not isinstance(references, list) or not references:
        raise ReferenceProblem("'items' must be a non-empty list of references")
    if len(references) > MAX_REFERENCES:
        raise ReferenceProblem(f"at most {MAX_REFERENCES} items at once")
    satellite, entry = provider(engine, capability)
    if satellite is None:
        raise ReferenceProblem(f"nothing provides {capability} on this server")
    if "resolve" not in entry["operations"]:
        raise ReferenceProblem(f"the {capability} provider can't confirm its items")
    name = satellite.manifest.name

    resolved, refused, seen = [], [], set()
    for index, reference in enumerate(references):
        reason = None
        if not isinstance(reference, dict) or set(reference) - REFERENCE_KEYS:
            reason = "not a reference"
        elif reference.get("capability") != capability:
            reason = f"not a {capability} item"
        elif reference.get("provider") != name:
            reason = "not from this server's provider"
        elif not isinstance(reference.get("id"), str) or not ITEM_ID.match(reference["id"]):
            reason = "not an item id"
        if reason is None:
            response = call(engine, capability, "resolve", (reference["id"],), token=token)
            payload = getattr(response, "payload", None)
            if (response is None or response.status != 200 or not isinstance(payload, dict)
                    or payload.get("id") != reference["id"]):
                reason = "no such item, or not one that can be moved now"
            elif reference["id"] not in seen:
                seen.add(reference["id"])
                resolved.append({"provider": name, "capability": capability, "id": payload["id"],
                                 "kind": payload.get("kind")})
        if reason is not None:
            refused.append({"index": index, "reason": reason})
    return resolved, refused


def still_resolves(engine, capability: str, reference: dict, token: str = "") -> bool:
    """Whether a reference resolved earlier still names the same provider's item now - the check
    made again at the moment of acting on it."""
    satellite, _entry = provider(engine, capability)
    if satellite is None or reference.get("provider") != satellite.manifest.name:
        return False
    response = call(engine, capability, "resolve", (reference.get("id", ""),), token=token)
    payload = getattr(response, "payload", None)
    return bool(response is not None and response.status == 200 and isinstance(payload, dict)
                and payload.get("id") == reference.get("id"))
