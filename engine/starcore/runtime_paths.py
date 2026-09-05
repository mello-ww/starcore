"""Where StarCore's own runtime-generated, machine-specific data lives.

Credentials, sessions, and a Satellite's own generated secrets (the Locked
Folder's PIN hash, specifically) are machine-specific state, not source code
- they have no business inside the Git checkout, the same way a desktop
application's user data never lives inside its own installation directory.
This module is the one place that decides where that data actually goes, so
nothing else in the Engine hard-codes a location or reinvents the same
platform logic - see docs/deployment.md, "Runtime data location", for the
full reasoning and the historical in-checkout locations this replaces.

Deliberately small and dependency-free, matching the rest of the Engine.
"""

from pathlib import Path
import os
import shutil
import sys

# the one escape hatch every caller here goes through - tests use it to stay
# fully isolated from whatever is actually on the machine running them, and
# it doubles as the supported way to relocate everything (a shared/service
# install that wants a fixed path like /var/lib/starcore, say) without
# touching a single tracked source file
ENV_OVERRIDE = "STARCORE_DATA_DIR"


def data_dir() -> Path:
    """StarCore's application-data directory for this machine/user.

    Resolution order:
    1. the STARCORE_DATA_DIR environment variable, if set - always wins,
       whatever the platform;
    2. otherwise a normal per-user, OS-appropriate location:
       - Windows: %APPDATA%\\StarCore
       - Linux/macOS: $XDG_DATA_HOME/starcore, defaulting to
         ~/.local/share/starcore

    Never created here - the directory (and any subdirectory beneath it)
    is created lazily by whoever first actually has something to write,
    the same way every other on-disk store in StarCore already works
    (AuthStore._save(), LockedFolderRuntime._save_pin(), ...).
    """
    override = os.environ.get(ENV_OVERRIDE)
    if override:
        return Path(override).expanduser()

    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "StarCore"

    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "starcore"


def migrate_legacy_file(legacy_path, new_path) -> Path:
    """Moves a single runtime-data file from a historical, in-checkout
    location to `new_path`, once, the first time this runs for a given
    pair of paths - never destructive, and safe to call on every startup.

    Returns the path the caller should actually use:
    - `new_path`, once the file lives there - whether it was already there
      (already migrated, or a fresh install with nothing to migrate at
      all) or was just moved there by this call;
    - `legacy_path` unchanged if the move itself fails for any reason (a
      cross-device restriction, a permissions problem, ...) - logged, not
      raised, so a migration StarCore cannot complete never loses the
      file or crashes startup over it. Migration is simply retried the
      next time StarCore starts, since nothing was removed from
      `legacy_path` in that case.

    Uses shutil.move() rather than a plain rename/Path.replace(): the new
    location is normally on a different filesystem entirely from the Git
    checkout (a different drive on Windows, a different mount on Linux/
    macOS), and a same-filesystem rename cannot cross that boundary the
    way a copy-then-remove can.
    """
    legacy_path = Path(legacy_path)
    new_path = Path(new_path)

    if new_path.exists() or not legacy_path.is_file():
        return new_path

    try:
        new_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy_path), str(new_path))
        print(f"[INFO]: migrated {legacy_path} to {new_path} - see docs/deployment.md, "
              f"\"Runtime data location\".")
        return new_path
    except OSError as error:
        print(f"[WARNING]: could not migrate {legacy_path} to {new_path} ({error}). "
              f"Continuing to use {legacy_path} for now - this will be retried next start.")
        return legacy_path
