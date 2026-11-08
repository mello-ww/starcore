from pathlib import Path
import tomllib

from .satellite import Satellite
from .satellite_registry import SatelliteRegistry
from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig
from .module_loader import load_module_from_file, register_package
from . import ui_contract


class SatelliteLoadError(Exception):
    """Raised when a satellite's manifest can no longer be read from disk.

    Everything else a satellite ships (state.py, api.py, satellite.py, its
    Mission Control page) is optional and a failure to load one is only ever
    a warning - the manifest is the one thing a satellite cannot exist
    without, at discovery time or on a reload.
    """


class SatelliteLoader:
    def __init__(self, registry: SatelliteRegistry, native_path: Path, link_path: Path):
        self.registry = registry
        self.native_path = native_path
        self.link_path = link_path

    def _discover_directory(self, path: Path, satellite_type: str):
        if not path.exists():
            print(f"[WARNING]: Directory {path} does not exist. Skipping discovery for {satellite_type} satellites.")
            return

        # directory iteration order is not guaranteed and differs by platform
        # and filesystem, so it's sorted to keep discovery order (and therefore
        # Mission Control's sidebar) the same on every machine
        for satellite_dir in sorted(path.iterdir()):
            if not satellite_dir.is_dir():
                continue

            try:
                satellite = self._build_satellite(satellite_dir, satellite_type)
            except SatelliteLoadError as error:
                print(f"[WARNING]: {error}. Skipping.")
                continue

            self.registry.add(satellite)

    def reload(self, satellite: Satellite) -> Satellite:
        """Rebuilds one satellite from disk, exactly the way discovery does.

        Raises SatelliteLoadError if its manifest can no longer be read - the
        caller is expected to leave the existing satellite registered rather
        than lose it to a broken reload.
        """
        return self._build_satellite(satellite.path, satellite.type)

    def read_metadata(self, satellite_dir: Path):
        """(manifest, ui definition) read from disk exactly as discovery
        does, without importing any of the Satellite's code - what
        StarCore.rediscover() refreshes. Raises SatelliteLoadError."""
        manifest = self.read_manifest(satellite_dir)
        return manifest, ui_contract.load_definition(satellite_dir, manifest.name, manifest.provides)

    def read_manifest(self, satellite_dir: Path) -> SatelliteManifest:
        manifest_path = satellite_dir / "satellite.toml"
        if not manifest_path.exists():
            raise SatelliteLoadError(f"satellite.toml not found for satellite in {satellite_dir}")

        try:
            with open(manifest_path, "rb") as file:
                manifest_data = tomllib.load(file)
            manifest = SatelliteManifest(
                name=manifest_data["name"],
                version=manifest_data["version"],
                author=manifest_data["author"],
                description=manifest_data["description"],
                icon=manifest_data.get("icon"),
                section_of=manifest_data.get("section_of") or None,
                icon_name=manifest_data.get("icon_name") or None,
            )
        except (tomllib.TOMLDecodeError, KeyError) as error:
            raise SatelliteLoadError(f"satellite.toml for satellite in {satellite_dir} is invalid ({error})")

        if manifest.icon and not (satellite_dir / "mission_control" / manifest.icon).is_file():
            print(f"[WARNING]: icon '{manifest.icon}' declared for satellite '{manifest.name}' "
                  f"was not found under mission_control/. Falling back to the generic icon.")
            manifest.icon = None
        if manifest.icon_name and manifest.icon_name not in ui_contract.ICONS:
            print(f"[WARNING]: icon_name '{manifest.icon_name}' of satellite '{manifest.name}' is not in "
                  f"the shared icon set. Clients fall back to a generic icon.")
            manifest.icon_name = None
        manifest.provides, problems = ui_contract.normalise_provides(manifest_data.get("provides"))
        for problem in problems:
            print(f"[WARNING]: satellite '{manifest.name}': {problem}. That capability is not offered.")
        return manifest

    def _build_satellite(self, satellite_dir: Path, satellite_type: str) -> Satellite:
        manifest = self.read_manifest(satellite_dir)

        config_path = satellite_dir / "config.toml"
        defaults_path = satellite_dir / "config.default.toml"
        if config_path.exists():
            with open(config_path, "rb") as file:
                config_data = tomllib.load(file)
        else:
            if not defaults_path.is_file():
                print(f"[WARNING]: config.toml not found for satellite {manifest.name}. Using empty config.")
            # else: no config.toml yet, but this satellite ships a
            # config.default.toml (see docs/deployment.md, "Keeping
            # configuration up to date") - SatelliteConfig below bootstraps
            # one from it, so this isn't the "using empty config" case above
            config_data = {}
        config = SatelliteConfig(
            data=config_data,
            path=config_path,
            defaults_path=defaults_path,
        )
        package = f"satellites.{satellite_type}.{satellite_dir.name}"
        register_package(package, satellite_dir)
        state_provider = self._load_state_provider(satellite_dir, package, manifest.name)
        routes = self._load_routes(satellite_dir, package, manifest.name)
        page = self._load_page(satellite_dir)
        lifecycle = self._load_lifecycle(satellite_dir, package, manifest.name)
        ui = ui_contract.load_definition(satellite_dir, manifest.name, manifest.provides)
        return Satellite(manifest, config, satellite_type, satellite_dir, state_provider, routes, page, lifecycle, ui)

    def _load_state_provider(self, satellite_dir: Path, package: str, satellite_name: str):
        state_path = satellite_dir / "state.py"
        if not state_path.exists():
            return None

        try:
            module = load_module_from_file(f"{package}.state", state_path)
        except Exception as error:
            print(f"[WARNING]: state module of satellite '{satellite_name}' could not be loaded ({error}). Skipping.")
            return None

        provider = getattr(module, "state", None)
        if provider is None:
            print(f"[WARNING]: {state_path} has no entry function 'state'. Skipping.")

        return provider

    def _load_routes(self, satellite_dir: Path, package: str, satellite_name: str) -> dict:
        api_path = satellite_dir / "api.py"
        if not api_path.exists():
            return {}

        try:
            module = load_module_from_file(f"{package}.api", api_path)
            routes = module.routes()
        except Exception as error:
            print(f"[WARNING]: api module of satellite '{satellite_name}' could not be loaded ({error}). Skipping.")
            return {}

        if not isinstance(routes, dict) or not all(callable(handler) for handler in routes.values()):
            print(f"[WARNING]: {api_path} did not return a mapping of route names to handlers. Skipping.")
            return {}

        return routes

    def _load_lifecycle(self, satellite_dir: Path, package: str, satellite_name: str) -> dict:
        module_path = satellite_dir / "satellite.py"
        if not module_path.exists() or module_path.stat().st_size == 0:
            return {}

        try:
            module = load_module_from_file(f"{package}.satellite", module_path)
        except Exception as error:
            print(f"[WARNING]: satellite module of '{satellite_name}' could not be loaded ({error}). Skipping.")
            return {}

        return {hook: getattr(module, hook) for hook in ("start", "stop") if callable(getattr(module, hook, None))}

    def _load_page(self, satellite_dir: Path):
        assets = satellite_dir / "mission_control"
        if not (assets / "page.js").is_file():
            return None

        page = {"module": "page.js"}
        if (assets / "page.css").is_file():
            page["stylesheet"] = "page.css"

        return page
