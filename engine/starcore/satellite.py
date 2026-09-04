from pathlib import Path

from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig

class Satellite:
    def __init__(self, manifest: SatelliteManifest, config: SatelliteConfig, satellite_type: str, path: Path,
                 state_provider=None, routes: dict = None, page: dict = None, lifecycle: dict = None):
        self.manifest = manifest
        self.config = config
        self.type = satellite_type
        self.path = path
        self.state_provider = state_provider
        self.routes = routes or {}
        self.page = page
        self.lifecycle = lifecycle or {}
        # None until a start/stop hook has actually run once - a satellite with
        # no background service (see has_service) never gets a True/False value
        # and is simply "running" whenever it's enabled, since there's nothing
        # to actually be stopped
        self.running = None
        self.last_error = None

    @property
    def assets_path(self) -> Path:
        return self.path / "mission_control"

    @property
    def enabled(self) -> bool:
        return bool(self.config.get("enabled", True))

    @property
    def has_service(self) -> bool:
        """Whether this satellite declares a start/stop hook at all - see
        "Running a background service" in docs/satellites.md. Purely generic:
        a satellite either wires up satellite.py or it doesn't, and the Core
        never needs to know which one this happens to be."""
        return bool(self.lifecycle)

    def start(self, engine) -> tuple:
        return self._run("start", engine)

    def stop(self, engine) -> tuple:
        return self._run("stop", engine)

    def _run(self, hook: str, engine) -> tuple:
        """Runs a lifecycle hook, isolating its failure the same way state() does.

        Returns (success, error) so a caller that needs to know what actually
        happened - Mission Control's enable/disable/reload controls, in
        particular - can report it honestly instead of assuming the hook
        worked just because it didn't crash the Core. A satellite with no
        hook for this event counts as a no-op success, matching the existing
        "both are optional" contract (see docs/satellites.md).
        """
        handler = self.lifecycle.get(hook)
        if handler is None:
            return True, None

        try:
            handler(engine, self)
        except Exception as error:
            message = f"{hook} hook of satellite '{self.manifest.name}' failed: {error}"
            print(f"[WARNING]: {message}")
            self.last_error = message
            return False, message

        self.last_error = None
        self.running = hook == "start"
        return True, None

    def state(self, engine) -> dict:
        if self.state_provider is None:
            return {}

        try:
            state = self.state_provider(engine, self)
        except Exception as error:
            print(f"[WARNING]: state provider of satellite '{self.manifest.name}' failed: {error}")
            return {}

        if not isinstance(state, dict):
            print(f"[WARNING]: state provider of satellite '{self.manifest.name}' did not return a dictionary. Ignoring.")
            return {}

        return state
