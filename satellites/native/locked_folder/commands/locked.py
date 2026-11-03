"""locked - the Locked Folder's lock state and diagnostics. Nothing private, ever.

This namespace deliberately has no command that unlocks, lists, reads,
moves or decrypts anything, or that sets, checks or resets a PIN, recovery
key or biometric device: those stay behind the Locked Folder's own PIN
flow. What it reports is what Mission Control's Locked Folder status shows
before unlocking - computed the same way, as if no session were unlocked.
"""

from starcore.cli.spec import Command, Unavailable

from .. import encryption
from ..runtime import runtime

NAMESPACE = "locked"
SUMMARY = "Locked Folder lock state and diagnostics (no private content)"
DEFAULT = "status"
ALIASES = ("locked-folder",)

READ = "locked_folder.read"


def status(ctx):
    satellite = ctx.engine.registry.get("LockedFolder")
    if satellite is None:
        raise Unavailable("the Locked Folder satellite is not loaded")
    live = runtime(satellite)
    root = live.configured_root
    crypt = encryption.status(live, root, unlocked=False)
    return {
        "configured": root is not None,
        "path_exists": root.is_dir() if root is not None else None,
        "pin_set": live.pin_set,
        "pin_unreadable": live.pin_unreadable,
        "biometric_devices": live.device_count(),
        "session_timeout_seconds": int(satellite.config.get("session_timeout_seconds", 900)),
        "security_problem": live.security_problem() if root is not None else None,
        "lockout": live.lockout_status(),
        "encryption": {key: crypt.get(key) for key in ("available", "state", "problem", "recovery_key")},
    }


def _render_status(data: dict) -> str:
    if not data["configured"]:
        return "Locked Folder   not configured"
    lockout = data["lockout"]
    crypt = data["encryption"]
    locked_out = f"locked out for {lockout['retry_after']}s" if lockout["retry_after"] else "no"
    return "\n".join([
        f"Locked Folder   configured{'' if data['path_exists'] else ' (directory missing)'}",
        f"PIN             {'set' if data['pin_set'] else 'not set'}{' (unreadable)' if data['pin_unreadable'] else ''}",
        f"Security        {data['security_problem'] or 'ok'}",
        f"Failed tries    {lockout['failed_attempts']} (lockouts: {lockout['lockouts']}, locked out: {locked_out})",
        f"Encryption      {crypt['state']}{' - ' + crypt['problem'] if crypt['problem'] else ''}"
        f"{'' if crypt['available'] else ' (cryptography package not installed)'}",
        f"Recovery key    {'set up' if crypt['recovery_key'] else 'none'}",
        f"Biometrics      {data['biometric_devices']} trusted device(s)",
    ])


COMMANDS = [
    Command("status", "Whether the Locked Folder is set up, locked out or damaged, and its encryption state",
            status, READ, remote=False, sensitive=True, render=_render_status,
            examples=("locked", "locked status --json")),
]
