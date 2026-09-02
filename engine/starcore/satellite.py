from pathlib import Path

from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig

class Satellite:
    def __init__(self, manifest: SatelliteManifest, config: SatelliteConfig, satellite_type: str, path: Path, state_provider=None):
        self.manifest = manifest
        self.config = config
        self.type = satellite_type
        self.path = path
        self.state_provider = state_provider

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
