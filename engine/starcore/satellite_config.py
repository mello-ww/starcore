from pathlib import Path

from .config_defaults import load_defaults, reconcile
from .toml_edit import write_value


class SatelliteConfig:
    """A satellite's own config.toml: a flat table, no [section] headers.

    Persistence here is purely mechanical - it writes whatever it's given and
    has no notion of which keys are valid or what a good value looks like. A
    satellite owns that: it validates before calling set(), the same way the
    Core's own Configuration does for [server].
    """

    def __init__(self, data: dict, path: Path = None, defaults_path: Path = None):
        """`defaults_path` is this satellite's own config.default.toml, if it
        ships one (see docs/deployment.md, "Keeping configuration up to
        date") - optional and None by default, so a SatelliteConfig built
        directly with just data/path (every test that isn't going through
        satellite discovery itself) behaves exactly as it always has.

        Reconciliation needs somewhere to persist a newly-added default, so
        it's skipped when this satellite has no config.toml of its own to
        write to yet (`path` is None) - discovery always gives one; this
        only matters for a SatelliteConfig built by hand.
        """
        self.data = data
        self.path = Path(path) if path is not None else None
        self.defaults_path = Path(defaults_path) if defaults_path is not None else None
        self.added_defaults = self._reconcile_defaults()

    def _reconcile_defaults(self) -> list:
        if self.path is None:
            return []

        defaults = load_defaults(self.defaults_path)
        added = reconcile(self.path, self.data, defaults)
        for _, key in added:
            print(f"[INFO]: added new configuration default '{key}' to {self.path} "
                  f"- see docs/deployment.md, \"Keeping configuration up to date\".")
        return added

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        if self.path is None:
            raise ValueError("this satellite has no config.toml to persist to")

        write_value(self.path, None, key, value)
        self.data[key] = value
        return value
