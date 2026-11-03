"""StarCore's version and build metadata, from one source of truth.

The release version is the repository's top-level VERSION file - the Android
app's build reads the very same file, so the two can never disagree about
which release they belong to. Everything else is read from Git, once, the
first time it's asked for:

- commit: the short SHA of the checked-out commit
- build:  the number of commits leading to it (monotonic along main, so a
          later build always has a larger number)
- date:   that commit's date (an Engine is run from a checkout, not built,
          so the commit date is its honest "build date")
- dirty:  whether tracked files differ from that commit

A field Git can't provide (no Git on PATH, a source archive without history)
is None - never guessed, so a bug report can't carry a made-up hash. Nothing
here names a path, host, user or setting, so it is safe to show any signed-in
user and to paste into a public bug report.
"""

from pathlib import Path
import functools
import os
import re
import subprocess

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION_FILE = REPO_ROOT / "VERSION"

# semver with an optional pre-release: 0.1.0, 0.1.0-alpha.1, 1.2.0-rc.2
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+)(?:\.(\d+))?)?$")


def read_version(path: Path = VERSION_FILE) -> str:
    """The release version from VERSION, validated - a malformed file is a
    packaging mistake worth failing loudly on, not something to display."""
    text = path.read_text(encoding="utf-8").strip()
    if not _VERSION.match(text):
        raise ValueError(f"{path} does not hold a version like 0.1.0 or 0.1.0-alpha.1: {text!r}")
    return text


def channel_of(version: str) -> str:
    """"alpha", "beta", "rc"... from the pre-release label, else "stable"."""
    match = _VERSION.match(version)
    label = match.group(4) if match else None
    return label.lower() if label else "stable"


def _git(*args: str):
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args],
            capture_output=True, text=True, timeout=5,
            # read-only: never take index.lock just to refresh stat info
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


@functools.lru_cache(maxsize=1)
def info() -> dict:
    version = read_version()
    commit = _git("rev-parse", "--short=7", "HEAD")
    build = _git("rev-list", "--count", "HEAD") if commit else None
    date = _git("log", "-1", "--format=%cI", "HEAD") if commit else None
    status = _git("status", "--porcelain", "--untracked-files=no") if commit else None
    return {
        "version": version,
        "channel": channel_of(version),
        "build": int(build) if build and build.isdigit() else None,
        "commit": commit or None,
        "dirty": bool(status) if status is not None else None,
        "date": date or None,
    }


def describe(build: dict = None) -> str:
    """One line for the startup log: 'StarCore 0.1.0-alpha.1 (alpha, build 66, fdfa361)'."""
    build = build or info()
    details = [build["channel"]]
    if build["build"] is not None:
        details.append(f"build {build['build']}")
    if build["commit"]:
        details.append(build["commit"] + ("+changes" if build["dirty"] else ""))
    return f"StarCore {build['version']} ({', '.join(details)})"
