import threading
import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ENGINE_DIR / "config.toml"

BASE_DIR = ENGINE_DIR.parent

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080


from .engine_config import Configuration
from .satellite_loader import SatelliteLoader
from .satellite_registry import SatelliteRegistry
from .satellite import Satellite
from .manifest import SatelliteManifest
from .command_registry import CommandRegistry
from .command_loader import CommandLoader
from .api import ApiServer
from .cli.parser import parse


class StarCore:
    def __init__(self, config_path: Path = CONFIG_PATH):
        self.config = Configuration(config_path)
        self.registry = SatelliteRegistry()
        self.native_path = BASE_DIR / "satellites" / "native"
        self.link_path = BASE_DIR / "satellites" / "link"
        self.loader = SatelliteLoader(self.registry, self.native_path, self.link_path)
        self.command_registry = CommandRegistry()
        self.command_loader = CommandLoader(
            self.command_registry,
            ENGINE_DIR / "starcore" / "cli" / "commands"
        )

        server_config = self.config.section("server")
        self.mission_control_enabled = bool(server_config.get("enabled", True))
        self.satellite_services_enabled = bool(self.config.section("satellites").get("services", True))
        self.api = ApiServer(
            self,
            server_config.get("host", DEFAULT_HOST),
            server_config.get("port", DEFAULT_PORT),
            BASE_DIR / "mission_control"
        )

        self._running = False
        self._started_at = None
        self.stopped = threading.Event()

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
        for satellite in self.registry.all():
            self.command_loader.discover_satellite(satellite)
        print(f"\nCommands discovered: {len(self.command_registry.all())}")

        self._started_at = time.time()
        self._running = True

        if self.satellite_services_enabled:
            print("\nStarting satellites...")
            for satellite in self.registry.all():
                if satellite.enabled:
                    satellite.start(self)

        print("\nStarting Mission Control...")
        if not self.mission_control_enabled:
            print("Mission Control is disabled.")
        elif self.api.start():
            print(f"Mission Control available at {self.api.url}")

        print("\nStarCore is ready.")


    def stop(self):
        if not self._running:
            return

        print("\nStopping StarCore...")
        self.api.stop()
        if self.satellite_services_enabled:
            for satellite in self.registry.all():
                satellite.stop(self)
        self._running = False
        print("StarCore has stopped.")
        # signals both the CLI reader thread and anyone else waiting for shutdown
        # (e.g. a remote shutdown request handled on the API's own thread)
        self.stopped.set()

    def execute_command(self, command: str):
        return parse(command, self, self.command_registry)

    def status(self) -> dict:
        satellites = self.registry.all()
        native_count = sum(1 for satellite in satellites if satellite.type == "native")
        link_count = sum(1 for satellite in satellites if satellite.type == "link")

        return {
            "engine": self.config.section("engine").get("name", "StarCore"),
            "running": self._running,
            "uptime_seconds": round(time.time() - self._started_at, 1) if self._running else 0.0,
            "satellites": {
                "total": len(satellites),
                "native": native_count,
                "link": link_count,
            },
            "commands": len(self.command_registry.all()),
            "mission_control": {
                "enabled": self.mission_control_enabled,
                "running": self.api.running,
                "url": self.api.url if self.api.running else None,
            },
        }
