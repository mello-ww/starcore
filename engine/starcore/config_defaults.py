"""Fills in configuration keys a newer StarCore version has introduced,
without ever touching a value the installation already has.

Both `engine_config.Configuration` (a `[section]`-based config.toml) and
`satellite_config.SatelliteConfig` (a flat one) call this the same way: with
their own live path/data, and the config.default.toml shipped right next to
it, if one exists. A section is simply a value that is itself a dict here -
everything else is a leaf - so the exact same function reconciles both
shapes; neither caller needs its own version of this.

This is the piece that lets `git pull` add a new default setting without
ever conflicting with a machine's own edited config.toml: the tracked
config.default.toml is the only file a future StarCore version changes to
introduce one, and every value the running installation already has -
however it got there - is left completely alone. See docs/deployment.md,
"Configuration" and "Keeping configuration up to date".
"""

from pathlib import Path
import tomllib

from .toml_edit import write_value


def load_defaults(defaults_path) -> dict:
    """The shipped config.default.toml next to a config.toml - or {} when
    there isn't one (an installation, or a satellite, that predates this,
    or simply doesn't ship one), which makes reconcile() below a no-op,
    exactly like before this existed."""
    if defaults_path is None:
        return {}

    defaults_path = Path(defaults_path)
    if not defaults_path.is_file():
        return {}

    try:
        with open(defaults_path, "rb") as file:
            return tomllib.load(file)
    except tomllib.TOMLDecodeError as error:
        print(f"[WARNING]: defaults file {defaults_path} is invalid ({error}). Skipping.")
        return {}


def reconcile(path: Path, live_data: dict, defaults_data: dict, section=None) -> list:
    """Adds every key present in `defaults_data` but missing from
    `live_data` - at any depth - writing each one to `path` (through
    toml_edit.write_value, so comments and everything else already in the
    file are left exactly as they were) and updating `live_data` in place to
    match. Returns the (section, key) pairs that were added, in the order
    they were found; `section` is None for a flat file's own top-level keys,
    or the name of the `[section]` a nested default dict belongs to.

    Never overwrites a key `live_data` already has, at any depth, and never
    removes a key `live_data` has that `defaults_data` doesn't (an
    installation's own custom/legacy setting is left alone, not treated as
    something to clean up here) - only ever adds what's missing.
    """
    added = []
    for key, value in defaults_data.items():
        if isinstance(value, dict):
            live_section = live_data.setdefault(key, {})
            added.extend(reconcile(path, live_section, value, section=key))
            continue

        if key in live_data:
            continue

        write_value(path, section, key, value)
        live_data[key] = value
        added.append((section, key))

    return added
