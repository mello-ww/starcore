"""Path resolution and safety for the File Explorer satellite.

The configured root (see config.toml's "root") is the entire security
boundary. Every operation goes through resolve() before touching the
filesystem - nothing a request supplies is ever trusted or used directly
(see docs/api.md - File Explorer - Security). This is the one module that
matters for that guarantee; api.py never builds a filesystem path itself.
"""

from pathlib import Path


class PathError(Exception):
    """Raised when a requested path is invalid or would escape the configured root."""


def storage_root(satellite) -> Path:
    """Resolves and creates the configured root - mirrors Photo's and Music's
    own 'storage' resolution convention exactly (relative paths are resolved
    inside the satellite's own directory, never the server's real root)."""
    configured = Path(str(satellite.config.get("root", "data"))).expanduser()
    root = configured if configured.is_absolute() else satellite.path / configured
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve(root: Path, relative: str) -> Path:
    """Turns a browser-supplied relative path into a real filesystem path
    guaranteed to be inside `root`, or raises PathError.

    Never trusts the client: the path arrives already URL-decoded (the
    server decodes query values before a satellite ever sees them), so a
    literal '..' segment - encoded or not - is caught here the same way,
    and an absolute-looking segment is just another path component relative
    to root, never a jump to the real filesystem root. Once a candidate
    path is built, it's resolved (following any symlinks) and re-checked
    for containment - so a symlink *inside* root that points outside it is
    caught too, not just '..' in the request itself.
    """
    relative = (relative or "").strip("/").replace("\\", "/")
    segments = [segment for segment in relative.split("/") if segment not in ("", ".")]

    if any(segment == ".." for segment in segments):
        raise PathError("the path may not contain '..'")

    candidate = root.joinpath(*segments) if segments else root

    try:
        resolved = candidate.resolve()
    except (OSError, RuntimeError) as error:
        raise PathError(f"the path could not be resolved ({error})")

    if resolved != root and root not in resolved.parents:
        raise PathError("the path is outside the configured root")

    return resolved


def relative_path(root: Path, path: Path) -> str:
    return "" if path == root else str(path.relative_to(root)).replace("\\", "/")


def safe_name(name: str) -> str:
    """Validates a bare filename/directory name (never a path) for create/
    rename operations - no separators, no '..', nothing empty.
    """
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise PathError("not a valid file or directory name")
    return name
