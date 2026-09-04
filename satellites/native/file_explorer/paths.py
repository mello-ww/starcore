"""Path resolution and safety for the File Explorer satellite.

File Explorer gives access to the entire filesystem the StarCore process
itself can reach - there is no sandbox or configured root confining it (see
"File Explorer" in docs/api.md). The operating system's own permissions are
the only boundary that matters: this module's job is turning a request's
path into a real, canonical filesystem Path and rejecting anything
malformed before it ever reaches the filesystem; actual existence and
permission checks happen in api.py, which turns the OS's own errors into
clean responses instead of ever letting one crash the request.
"""

from pathlib import Path
import os
import string


class PathError(Exception):
    """Raised when a requested path is malformed (never for a permission or
    existence problem - those are for the caller to turn into a clean,
    specific response once the operating system actually reports one)."""


def list_roots() -> list:
    """The starting points File Explorer offers to browse from.

    A single '/' on Linux/macOS - the one real filesystem root there. On
    Windows there is no equivalent single root; every drive letter that
    actually exists is its own root, and nothing here assumes StarCore is
    installed on any particular one.
    """
    if os.name == "nt":
        return [drive for letter in string.ascii_uppercase
                if (drive := Path(f"{letter}:\\")).exists()]
    return [Path("/")]


def resolve_path(raw: str) -> Path:
    """Turns a browser-supplied absolute path into a real, canonical Path.

    The path must already be absolute - a relative path (including one that
    leans on '..' to climb above wherever the caller assumes it starts) is
    not a legitimate request here, since there is no boundary to climb out
    of in the first place; it is rejected as malformed rather than silently
    reinterpreted. Whatever the path resolves to - including through a
    symlink - is used as-is. Whether it can actually be read, written,
    listed or deleted is entirely up to the operating system's own
    permissions, which the caller checks once it tries.
    """
    text = (raw or "").strip()
    if not text:
        raise PathError("no path was given")
    if "\x00" in text:
        raise PathError("the path contains an invalid character")

    candidate = Path(text)
    if not candidate.is_absolute():
        raise PathError("the path must be absolute")

    try:
        return candidate.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise PathError(f"the path could not be resolved ({error})")


def is_filesystem_root(path: Path) -> bool:
    """True for '/' on Linux/macOS, or a drive root such as 'C:\\' on
    Windows - the top of a filesystem, which can never be renamed or
    deleted, however permissive the operating system is willing to be."""
    return path.parent == path


def parent_of(path: Path):
    """The path to show when the user asks to go up a level, or None if
    there is nowhere further up - only true at the very top, the list of
    roots itself (which list_roots() returns, and which is not itself
    addressed by any single path)."""
    if is_filesystem_root(path):
        return ""  # up from a real root goes to the list of roots
    return str(path.parent)


def safe_name(name: str) -> str:
    """Validates a bare filename/directory name (never a path) for create/
    rename operations - no separators, no '..', nothing empty.
    """
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise PathError("not a valid file or directory name")
    return name
