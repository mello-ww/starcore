from pathlib import Path

from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig

class Satellite:
    def __init__(self, manifest: SatelliteManifest, config: SatelliteConfig, satellite_type: str, path: Path,
                 state_provider=None, routes: dict = None, page: dict = None, lifecycle: dict = None):
        self.manifest = manifest
        self.config = config
        self.type = satellite_type
        self.path = path
        self.state_provider = state_provider
        self.routes = routes or {}
        self.page = page
        self.lifecycle = lifecycle or {}

    @property
    def assets_path(self) -> Path:
        return self.path / "mission_control"

    @property
    def enabled(self) -> bool:
        return bool(self.config.get("enabled", True))

    def start(self, engine):
        self._run("start", engine)

    def stop(self, engine):
        self._run("stop", engine)

    def _run(self, hook: str, engine):
        handler = self.lifecycle.get(hook)
        if handler is None:
            return

        try:
            handler(engine, self)
        except Exception as error:
            print(f"[WARNING]: {hook} hook of satellite '{self.manifest.name}' failed: {error}")

    def state(self, engine) -> dict:
        if self.state_provider is None:
            return {}

        try:
            state = self.state_provider(engine, self)
        except Exception as error:
            print(f"[WARNING]: state provider of satellite '{self.manifest.name}' failed: {error}")
            return {}

        if not isinstance(state, dict):
            print(f"[WARNING]: state provider of satellite '{self.manifest.name}' did not return a dictionary. Ignoring.")
            return {}

        return state
