import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ENGINE_DIR / "config.toml"

BASE_DIR = ENGINE_DIR.parent


from .engine_config import Configuration
from .satellite_loader import SatelliteLoader
from .satellite_registry import SatelliteRegistry
from .satellite import Satellite
from .manifest import SatelliteManifest
from .command_registry import CommandRegistry
from .command_loader import CommandLoader
from .cli.parser import parse


class StarCore:
    def __init__(self):
        self.config = Configuration(CONFIG_PATH)
        self.registry = SatelliteRegistry()
        self.native_path = BASE_DIR / "satellites" / "native"
        self.link_path = BASE_DIR / "satellites" / "link"
        self.loader = SatelliteLoader(self.registry, self.native_path, self.link_path)
        self.command_registry = CommandRegistry()
        self.command_loader = CommandLoader(
            self.command_registry,
            ENGINE_DIR / "starcore" / "cli" / "commands"
        )

    def start(self):
        print("Starting StarCore...\n")

        print("Loading configuration...")
        print("Configuration loaded.\n")

        print("Discovering satellites...")
        self.loader._discover_directory(self.native_path, "native")
        self.loader._discover_directory(self.link_path, "link")
        print(f"Satellites discovered: {len(self.registry.all())}")
        for satellite in self.registry.all():
            print(f"- {satellite.manifest.name} v{satellite.manifest.version} ({satellite.type})")

        print("\nDiscovering commands...")
        self.command_loader.discover()
        print(f"\nCommands discovered: {len(self.command_registry.all())}")
        
        print("StarCore is ready.")


    def stop(self):
        print("\nStopping StarCore...")
        print("StarCore has stopped.")

    def execute_command(self, command: str):
        return parse(command, self, self.command_registry)
