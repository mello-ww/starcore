import threading
import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ENGINE_DIR / "config.toml"
CONFIG_DEFAULTS_PATH = ENGINE_DIR / "config.default.toml"

BASE_DIR = ENGINE_DIR.parent

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080


class SatelliteError(Exception):
    """Raised by the satellite management API for a request it cannot carry out.

    Defined before the imports below on purpose: starcore.api.server imports
    it back from here to report the same error over the API, and that import
    happens while this module is still mid-import (`from .api import
    ApiServer`, further down) - so the name has to already exist in this
    module's namespace by the time that circular import runs.
    """


from . import runtime_paths
from .auth import AuthStore
from .engine_config import Configuration
from .satellite_loader import SatelliteLoader, SatelliteLoadError
from .satellite_registry import SatelliteRegistry
from .satellite import Satellite
from .manifest import SatelliteManifest
from .command_registry import CommandRegistry
from .command_loader import CommandLoader
from .api import ApiServer
from .cli.parser import parse


class StarCore:
    def __init__(self, config_path: Path = CONFIG_PATH):
        # config.default.toml is always the one next to *this* engine's own
        # config.toml, regardless of which config_path was given - a test
        # passing its own temp config_path still reconciles against the real
        # shipped defaults, exactly as a real install would (see
        # docs/deployment.md, "Keeping configuration up to date")
        self.config = Configuration(config_path, defaults_path=CONFIG_DEFAULTS_PATH)
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
        # the credential/session store lives in StarCore's application-data
        # directory (see runtime_paths.data_dir()) - a fixed, non-configurable
        # location (unlike satellite config) since there's exactly one of
        # these per StarCore install and nothing satellite-specific ever
        # touches it. A store from before this was introduced - engine/data/
        # auth.json, inside the checkout - is migrated over automatically,
        # once, the first time this runs; see docs/deployment.md, "Runtime
        # data location".
        self.auth = AuthStore(runtime_paths.migrate_legacy_file(
            ENGINE_DIR / "data" / "auth.json",
            runtime_paths.data_dir() / "auth.json",
        ))
        https_cert = server_config.get("https_cert", "")
        https_key = server_config.get("https_key", "")
        self.api = ApiServer(
            self,
            server_config.get("host", DEFAULT_HOST),
            server_config.get("port", DEFAULT_PORT),
            BASE_DIR / "mission_control",
            https_enabled=bool(server_config.get("https_enabled", False)),
            https_cert=Path(https_cert) if https_cert else None,
            https_key=Path(https_key) if https_key else None,
        )

        self._running = False
        self._started_at = None
        self.stopped = threading.Event()
        # set by request_restart() just before it calls stop() - the process
        # entrypoint (starcore.cli.main.main()) checks this once stop() has
        # returned to decide whether to exit for good or re-exec itself, since
        # only that layer knows how the process was originally launched
        self.restart_requested = False

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

    def request_restart(self):
        """Stops the engine exactly like a normal shutdown, but flagged so the
        process entrypoint re-execs itself afterwards instead of exiting for
        good. No second shutdown implementation - this is stop() plus one bit
        of intent for whoever is waiting on `stopped`.
        """
        self.restart_requested = True
        self.stop()

    def execute_command(self, command: str):
        return parse(command, self, self.command_registry)

    def _require_satellite(self, name: str) -> Satellite:
        satellite = self.registry.get(name)
        if satellite is None:
            raise SatelliteError(f"unknown satellite '{name}'")
        return satellite

    def set_satellite_enabled(self, name: str, enabled: bool) -> dict:
        """Enables or disables one satellite through its own start/stop hooks.

        This is the same 'enabled' key a satellite's config.toml already
        carries (it's what start() has always checked before running a
        satellite's service at boot) - the difference is that this also
        actually starts or stops the satellite's live service to match,
        rather than only taking effect on the next restart.

        The hook runs before anything is persisted, and the config is only
        written once it reports success - a satellite whose stop hook fails
        stays 'enabled' rather than being marked disabled while its service
        may still be running, so Mission Control never shows a state that
        isn't real. Returns {"error": None} on success, or {"error": message}
        with the satellite left exactly as it was.
        """
        satellite = self._require_satellite(name)
        was_enabled = satellite.enabled

        if enabled == was_enabled:
            return {"satellite": satellite, "error": None}

        if self.satellite_services_enabled:
            ok, message = satellite.start(self) if enabled else satellite.stop(self)
            if not ok:
                return {"satellite": satellite, "error": message}

        satellite.config.set("enabled", enabled)
        return {"satellite": satellite, "error": None}

    def reload_satellite(self, name: str) -> dict:
        """Stops, rebuilds from disk and (if enabled) restarts one satellite.

        Nothing else in the Core is touched: the rest of the registry, every
        other satellite's routes and services, and Mission Control itself all
        keep running exactly as they were. If the satellite's manifest is
        broken, or its stop hook fails, the satellite already registered is
        left in place rather than replaced with something broken or
        restarted twice.
        """
        satellite = self._require_satellite(name)
        was_enabled = satellite.enabled

        if was_enabled and self.satellite_services_enabled:
            ok, message = satellite.stop(self)
            if not ok:
                return {"satellite": satellite, "error": f"could not stop before reload: {message}"}

        try:
            reloaded = self.loader.reload(satellite)
        except SatelliteLoadError as error:
            return {"satellite": satellite, "error": str(error)}

        self.registry.replace(reloaded)
        # a reloaded satellite's commands are rediscovered fresh - its old ones
        # have to be dropped first, since CommandRegistry.add() refuses to
        # overwrite an existing name rather than replacing it
        self.command_registry.remove_source(reloaded.manifest.name)
        self.command_loader.discover_satellite(reloaded)

        error = None
        if reloaded.enabled and self.satellite_services_enabled:
            ok, message = reloaded.start(self)
            if not ok:
                error = f"reloaded but could not start: {message}"

        return {"satellite": reloaded, "error": error}

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
