from pathlib import Path

from .manifest import SatelliteManifest

class Satellite:
    def __init__(self, manifest: SatelliteManifest, satellite_type: str, path: Path):
        self.manifest = manifest
        self.type = satellite_type
        self.path = path