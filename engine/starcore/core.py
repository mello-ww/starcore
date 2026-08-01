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

        print(f"Native satellites path: {self.native_path}")
        print(f"Link satellites path: {self.link_path}")
        print(f"Native satellites exist: {self.native_path.exists()}")
        print(f"Link satellites exist: {self.link_path.exists()}")
        print(f"Native satellite files: {list(self.native_path.iterdir())}")
        print(f"Link satellite files: {list(self.link_path.iterdir())}")
        print("Discovering satellites...")
        self.loader.discover()
        print(f"Satellites discovered: {len(self.registry.all())}")
        
        print("StarCore is ready.")

        try:
            while True:
                time.sleep(1)  # Keep the engine running
        except KeyboardInterrupt:
            self.stop()

    def stop(self):
        print("\nStopping StarCore...")
        print("StarCore has stopped.")