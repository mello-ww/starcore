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
import sys


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


# filesystems that are real storage (a disk, a partition or a network share), as opposed to
# the virtual ones (proc, tmpfs, overlay...) a Linux system also mounts
DISK_FILESYSTEMS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "vfat",
                    "exfat", "ntfs", "ntfs3", "fuseblk", "hfsplus", "apfs", "nfs", "nfs4", "cifs",
                    "smb3", "smbfs", "fuse.sshfs", "9p"}


def _unescape_mount(path: str) -> str:
    """/proc/mounts writes spaces, tabs and backslashes in a mount point as octal."""
    return (path.replace("\\040", " ").replace("\\011", "\t")
            .replace("\\012", "\n").replace("\\134", "\\"))


def mounts() -> list:
    """The mounted disks on Linux as (mount point, device, filesystem), one per device: the
    shallowest mount point wins, so a bind mount of a disk elsewhere does not list it twice.
    Empty anywhere /proc/self/mounts is not readable (Windows, macOS)."""
    if not sys.platform.startswith("linux"):
        return []
    try:
        text = Path("/proc/self/mounts").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    best = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        device, mount, filesystem = parts[0], _unescape_mount(parts[1]), parts[2]
        if filesystem not in DISK_FILESYSTEMS or device.startswith("/dev/loop"):
            continue
        known = best.get(device)
        if known is None or len(Path(mount).parts) < len(Path(known[0]).parts):
            best[device] = (mount, device, filesystem)
    return sorted(best.values(), key=lambda item: item[0])


def list_locations() -> list:
    """What the home page offers: the roots, plus on Linux every mounted disk with its mount
    point (the way a server's own storage page lists them). Browsing is not confined to
    these: they are shortcuts to where each disk is mounted."""
    roots = list_roots()
    found = list(roots)
    taken = {str(root) for root in roots}
    for mount, _device, _filesystem in mounts():
        if mount not in taken and Path(mount).is_dir():
            taken.add(mount)
            found.append(Path(mount))
    return found


def mount_label(path: Path) -> str:
    """"ext4 on /dev/sdb1" for a mount point, "" for anything else."""
    for mount, device, filesystem in mounts():
        if mount == str(path):
            return f"{filesystem} on {device}"
    return ""


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
