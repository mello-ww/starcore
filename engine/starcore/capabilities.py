"""Satellite capabilities as the Engine itself uses them: finding a capability's provider, and
resolving the references clients send.

A reference ({provider, capability, id}) comes from a client and is only a claim about an item.
Before a Satellite acts on one, it asks the Engine, which:

- finds the provider of the capability in its own registry (the first enabled Satellite that
  declares it), never from what the reference says;
- refuses a reference whose provider or capability isn't exactly that;
- asks that provider, through its `resolve` operation and with the caller's own session,
  whether the id names an item the person may act on now.

Only the provider's answer counts. Nothing here names a Satellite.
See docs/ui-contract.md, "Shared blocks and Satellite capabilities".
"""

import re

from .api.response import Request

# at most this many references in one request (a selection's bulk limit)
MAX_REFERENCES = 500
REFERENCE_KEYS = {"provider", "capability", "id", "kind"}
ITEM_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def provider(engine, capability: str):
    """(satellite, {version, operations}) of the first enabled Satellite providing
    `capability`, or (None, None)."""
    for satellite in engine.registry.all():
        entry = satellite.manifest.provides.get(capability)
        if entry is not None and satellite.enabled:
            return satellite, entry
    return None, None


def call(engine, capability: str, operation: str, path: tuple = (), query: dict = None, token: str = ""):
    """Runs a GET operation of the capability's provider in-process, with the caller's session,
    as if the client had asked it. The Response, or None when there is no provider, it lacks the
    operation, or it failed."""
    satellite, entry = provider(engine, capability)
    if satellite is None or operation not in entry["operations"]:
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
