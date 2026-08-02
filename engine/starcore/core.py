import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ENGINE_DIR / "config.toml"

BASE_DIR = ENGINE_DIR.parent


from .config import Configuration
from .loader import SatelliteLoader
from .registry import SatelliteRegistry
from .satellite import Satellite


class StarCore:
    def __init__(self):
        self.config = Configuration(CONFIG_PATH)
        self.registry = SatelliteRegistry()
        self.native_path = BASE_DIR / "satellites" / "native"
        self.link_path = BASE_DIR / "satellites" / "link"
        self.loader = SatelliteLoader(self.registry, self.native_path, self.link_path)

    def start(self):
        print("Starting StarCore...\n")

        print("Loading configuration...")
        print(self.config.get("engine"))
        print("Configuration loaded.\n")

        print("Discovering satellites...")
        self.loader._discover_directory(self.native_path, "native")
        self.loader._discover_directory(self.link_path, "link")
        print(f"Satellites discovered: {len(self.registry.all())}")
        for satellite in self.registry.all():
            print(f"- {satellite.name} ({satellite.type})")
        
        print("StarCore is ready.")

        try:
            while True:
                time.sleep(1) 
        except KeyboardInterrupt:
            self.stop()

    def stop(self):
        print("\nStopping StarCore...")
        print("StarCore has stopped.")