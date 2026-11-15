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
renames or deletes a path, so no Satellite needs to know which one guards it. And whether media
was moved into a protected store (`sealed`, media.vault's optional `sealed`), so a library never
takes it back in. Both are asked as the Engine (`ENGINE_CALLER`), with the session of the request
being checked: a provider answers neither to a client.

`call` runs one provider's operation in-process for another Satellite: the Satellites that move
media between a library and a vault ask each other only this way, never by importing each
other. The request carries `caller`, which a client's request over HTTP never has, so an
operation meant for the server alone refuses clients (`refuse_clients`).

Nothing here names a Satellite.
See docs/ui-contract.md, "Shared blocks and Satellite capabilities".
"""

import re
from typing import NamedTuple, Optional

from .api.response import Request, error_response

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


# the caller the Engine's own checks (sealed) give, beside a Satellite's name
ENGINE_CALLER = "starcore"
SERVER_SIDE = "this is asked only by the server, never by a client"


def call(engine, capability: str, operation: str, path: tuple = (), query: dict = None, token: str = "",
         method: str = "GET", body=None, raw=None, caller: str = None):
    """Runs an operation of the capability's provider in-process, with the given session (empty
    for none), as if a client had asked it, or, with `caller` (the asking Satellite's name), as
    that Satellite asking through the Engine. `body` is a JSON body; `raw` a RawBody-like stream
    (read(size), length). The Response, or None when there is no provider, it lacks the operation,
    or it failed."""
    satellite, entry = provider(engine, capability)
    if satellite is None:
        return None
    return _run(engine, satellite, entry, capability, operation, path, query, token, method, body, raw, caller)


def offers(engine, capability: str, operations) -> bool:
    """Whether the capability's provider is there and offers every one of `operations`."""
    satellite, entry = provider(engine, capability)
    return satellite is not None and all(operation in entry["operations"] for operation in operations)


def provider_name(engine, capability: str):
    """The name of the capability's provider, or None."""
    satellite, _entry = provider(engine, capability)
    return None if satellite is None else satellite.manifest.name


def refuse_clients(request):
    """For an operation only the server asks: a 403 for a client's request (no `caller`), None
    when a Satellite or the Engine asked it through `call`."""
    return None if getattr(request, "caller", None) else error_response(SERVER_SIDE, status=403)


def _run(engine, satellite, entry, capability, operation, path=(), query=None, token="", method="GET",
         body=None, raw=None, caller=None):
    """One provider's operation, in-process: its Response, or None when it lacks the operation
    or failed."""
    if operation not in entry["operations"]:
        return None
    route = entry["operations"][operation].split("/")
    handler = satellite.routes.get(route[0])
    if handler is None:
        return None
    request = Request(engine, satellite, method, tuple(route[1:]) + tuple(path), dict(query or {}), body=body,
                      raw=raw, token=token, caller=caller)
    try:
        return handler(request)
    except Exception as error:
        print(f"[WARNING]: '{capability}' {operation} of '{satellite.manifest.name}' failed ({type(error).__name__}).")
        return None


# ---------- media moved into a protected store (media.vault's sealed) ----------

VAULT = "media.vault"
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def sealed(engine, digest: str) -> bool:
    """Whether media with this SHA-256 (lowercase hex) was moved into a protected store, as
    every media.vault provider that offers `sealed` answers: a library asks before it takes a
    file in, and refuses it when the answer is yes.

    Every provider is asked, enabled or not, as for `protection`: disabling one needs no PIN, so
    it must not let its media back into a library. A provider that fails, or answers anything
    but {sealed: bool}, counts as yes: the file stays out rather than risk taking in what was
    moved away on purpose."""
    if not isinstance(digest, str) or not DIGEST.match(digest):
        return False
    for satellite, entry in providers(engine, VAULT, enabled_only=False):
        if "sealed" not in entry["operations"]:
            continue
        response = _run(engine, satellite, entry, VAULT, "sealed", path=(digest,), caller=ENGINE_CALLER)
        payload = getattr(response, "payload", None)
        if (response is None or response.status != 200 or not isinstance(payload, dict)
                or not isinstance(payload.get("sealed"), bool)):
            print(f"[WARNING]: '{satellite.manifest.name}' could not say whether media was moved into it; "
                  "it stays out of the library.")
            return True
        if payload["sealed"]:
            return True
    return False


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
    response = _run(engine, satellite, entry, PROTECTED_FILES, "check", query=query, token=token,
                    caller=ENGINE_CALLER)
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
