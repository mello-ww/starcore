from pathlib import Path


from .satellite import Satellite
from .registry import SatelliteRegistry


class SatelliteLoader:
    def __init__(self, registry: SatelliteRegistry, native_path: Path, link_path: Path):
        self.registry = registry
        self.native_path = native_path
        self.link_path = link_path

    def _discover_directory(self, path: Path, satellite_type: str):
        if path.exists():
            for satellite_dir in path.iterdir():
                if satellite_dir.is_dir():
                    satellite_name = satellite_dir.name
                    satellite = Satellite(satellite_name, satellite_type, satellite_dir)
                    self.registry.add(satellite)

        else:
            print(f"Directory {path} does not exist. Skipping discovery for {satellite_type} satellites.")
            return
