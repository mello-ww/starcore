import secrets
import threading
import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ENGINE_DIR / "config.toml"
CONFIG_DEFAULTS_PATH = ENGINE_DIR / "config.default.toml"

BASE_DIR = ENGINE_DIR.parent

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080



# no 0/O or 1/I/L, so it reads back unambiguously from a terminal or a log
SETUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def new_setup_code() -> str:
    """A fresh one-time first-run setup code, e.g. "K7QM-2XRA-9PDF" (about 60
    bits - far beyond reach with guesses throttled per client)."""
    chars = "".join(secrets.choice(SETUP_CODE_ALPHABET) for _ in range(12))
    return "-".join(chars[i:i + 4] for i in range(0, 12, 4))

class SatelliteError(Exception):
    """Raised by the satellite management API for a request it cannot carry out.

    Defined before the imports below on purpose: starcore.api.server imports
    it back from here to report the same error over the API, and that import
    happens while this module is still mid-import (`from .api import
    ApiServer`, further down) - so the name has to already exist in this
    module's namespace by the time that circular import runs.
    """


from . import build_info, runtime_paths
from .auth import AuthStore
from .engine_config import Configuration
from .satellite_loader import SatelliteLoader, SatelliteLoadError
from .satellite_registry import SatelliteRegistry
from .satellite import Satellite
from .manifest import SatelliteManifest
from .command_registry import CommandRegistry
from .command_loader import CommandLoader
from .api import ApiServer
from .cli import runner
from .cli.audit import AuditLog


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
        # one-time code a remote first-run setup must present (set in start(),
        # cleared once the administrator exists) - see
        # RequestHandler._handle_auth_setup
        self.setup_code = None
        # state-changing and refused commands - see starcore/cli/audit.py
        self.audit = AuditLog(runtime_paths.data_dir() / "audit.log")
        # set only while the one-shot CLI may reach this process - see
        # starcore/cli/bridge.py; never handed to a web or mobile client
        self.control_token = None
        # Satellite folders rediscover() found on disk that aren't loaded -
        # new code is only ever loaded at startup (or by reload_satellite)
        self.pending_satellites = []
        self._loaded = False
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
        print("Starting StarCore...")
        print(build_info.describe() + "\n")

        print("Loading configuration...")
        print("Configuration loaded.\n")

        self.load()

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
            if not self.auth.is_bootstrapped:
                self.setup_code = new_setup_code()
                print("No administrator account yet. Create it in Mission Control - from any device")
                print(f"other than this machine, also enter this one-time setup code: {self.setup_code}")

        print("\nStarCore is ready.")

    def load(self):
        """Discovers satellites and commands without starting anything.

        start() runs this first; the one-shot CLI runs only this when no
        StarCore is running, so read-only commands still work offline
        (see starcore/cli/bridge.py). Safe to call more than once.
        """
        if self._loaded:
            return
        self._loaded = True

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

    def execute_command(self, command: str, interactive: bool = False):
        """Runs one line as the operator at this terminal and prints its output.

        Returns what an older single-function command returned (the terminal
        loop prints that, as it always has); a typed command prints its own
        output and returns None. Exit codes and structured results are on
        run_command() instead.
        """
        outcome = self.run_command(command, runner.terminal_context(self, interactive=interactive))
        if outcome.stdout:
            print(outcome.stdout, end="")
        if outcome.stderr:
            print(outcome.stderr, end="")
        return outcome.result

    def run_command(self, command, context):
        """Runs a command line (a string or a list of tokens) for `context` - see starcore/cli/runner.py."""
        return runner.run(self, command, context)

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

    def rediscover(self) -> dict:
        """Refreshes Satellite *metadata* from disk; never loads or reloads code.

        For every loaded Satellite, re-reads its ui.json and the presentational
        parts of its satellite.toml (icon_name, provides) - plain files, so
        this is safe while everything keeps running. Anything that would need
        new code is only reported:

        - "pending": a Satellite folder on disk that isn't loaded yet. Loading
          it means importing its Python, which happens at the next restart -
          rediscovery never hot-loads code.
        - "reload_required": a loaded Satellite whose name or version changed
          on disk - its code has changed too, so only reload_satellite (an
          explicit, per-Satellite action) or a restart applies it.
        - "missing": a loaded Satellite whose folder or manifest is gone. It
          keeps running as it is until StarCore restarts.
        """
        updated, reload_required, missing, errors = [], [], [], []
        loaded_paths = set()

        for satellite in self.registry.all():
            name = satellite.manifest.name
            loaded_paths.add(satellite.path.resolve())
            if not (satellite.path / "satellite.toml").is_file():
                missing.append(name)
                continue
            try:
                manifest, ui = self.loader.read_metadata(satellite.path)
            except SatelliteLoadError as error:
                errors.append({"satellite": name, "error": str(error)})
                continue
            if manifest.name != name or manifest.version != satellite.manifest.version:
                reload_required.append(name)
                continue
            before = (satellite.manifest.icon_name, satellite.manifest.provides,
                      satellite.ui.revision if satellite.ui else None, satellite.ui.error if satellite.ui else None)
            satellite.manifest.icon_name = manifest.icon_name
            satellite.manifest.provides = manifest.provides
            satellite.ui = ui
            after = (manifest.icon_name, manifest.provides, ui.revision if ui else None, ui.error if ui else None)
            if before != after:
                updated.append(name)

        pending = []
        for directory, satellite_type in ((self.native_path, "native"), (self.link_path, "link")):
            if not directory.is_dir():
                continue
            for candidate in sorted(directory.iterdir()):
                if not (candidate / "satellite.toml").is_file() or candidate.resolve() in loaded_paths:
                    continue
                try:
                    manifest = self.loader.read_manifest(candidate)
                except SatelliteLoadError as error:
                    errors.append({"folder": candidate.name, "error": str(error)})
                    continue
                pending.append({"name": manifest.name, "type": satellite_type, "folder": candidate.name})
        self.pending_satellites = pending

        from .api.payloads import catalog_revision
        return {"revision": catalog_revision(self), "updated": updated, "pending": pending,
                "reload_required": reload_required, "missing": missing, "errors": errors}

    def health(self) -> dict:
        """The engine, Mission Control and every satellite as pass/fail checks -
        what `engine health` and the Status satellite both report."""
        from .api.payloads import satellite_status

        checks = [{"check": "engine", "ok": self._running, "detail": "running" if self._running else "not running"}]
        if self.mission_control_enabled:
            checks.append({"check": "mission control", "ok": self.api.running,
                           "detail": self.api.url if self.api.running else "not running"})
        for satellite in self.registry.all():
            state = satellite_status(self, satellite)
            checks.append({"check": f"satellite {satellite.manifest.name}", "ok": state != "error",
                           "detail": satellite.last_error or state})
        return {"healthy": all(check["ok"] for check in checks), "checks": checks}

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
            # version, channel, build number, commit and date - see build_info.py
            "build": build_info.info(),
            "mission_control": {
                "enabled": self.mission_control_enabled,
                "running": self.api.running,
                "url": self.api.url if self.api.running else None,
            },
        }
