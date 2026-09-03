from pathlib import Path

from .toml_edit import write_value


class SatelliteConfig:
    """A satellite's own config.toml: a flat table, no [section] headers.

    Persistence here is purely mechanical - it writes whatever it's given and
    has no notion of which keys are valid or what a good value looks like. A
    satellite owns that: it validates before calling set(), the same way the
    Core's own Configuration does for [server].
    """

    def __init__(self, data: dict, path: Path = None):
        self.data = data
        self.path = Path(path) if path is not None else None

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        if self.path is None:
            raise ValueError("this satellite has no config.toml to persist to")

        write_value(self.path, None, key, value)
        self.data[key] = value
        return value
