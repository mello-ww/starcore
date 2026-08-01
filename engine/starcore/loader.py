from pathlib import Path


from .satellite import Satellite
from .registry import SatelliteRegistry


class SatelliteLoader:
    def __init__(self, registry: SatelliteRegistry, native_path: Path, link_path: Path):
        self.registry = registry
        self.native_path = native_path
        self.link_path = link_path

    def discover(self):
        #discover native satellites
        if self.native_path.exists():
            for satellite_dir in self.native_path.iterdir():
                if satellite_dir.is_dir():
                    satellite_name = satellite_dir.name
                    satellite = Satellite(satellite_name, "native", satellite_dir,)
                    self.registry.add(satellite)

        #discover link satellites
        if self.link_path.exists():
            for satellite_dir in self.link_path.iterdir():
                if satellite_dir.is_dir():
                    satellite_name = satellite_dir.name
                    satellite = Satellite(satellite_name, "link", satellite_dir,)
                    self.registry.add(satellite)