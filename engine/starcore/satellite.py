from pathlib import Path

from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig

class Satellite:
    def __init__(self, manifest: SatelliteManifest, config: SatelliteConfig, satellite_type: str, path: Path):
        self.manifest = manifest
        self.config = config
        self.type = satellite_type
        self.path = path