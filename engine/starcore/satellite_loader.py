from pathlib import Path
import tomllib

from .satellite import Satellite
from .satellite_registry import SatelliteRegistry
from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig
from .module_loader import load_module_from_file, register_package


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

    def _build_satellite(self, satellite_dir: Path, satellite_type: str) -> Satellite:
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
            )
        except (tomllib.TOMLDecodeError, KeyError) as error:
            raise SatelliteLoadError(f"satellite.toml for satellite in {satellite_dir} is invalid ({error})")

        if manifest.icon and not (satellite_dir / "mission_control" / manifest.icon).is_file():
            print(f"[WARNING]: icon '{manifest.icon}' declared for satellite '{manifest.name}' "
                  f"was not found under mission_control/. Falling back to the generic icon.")
            manifest.icon = None

        config_path = satellite_dir / "config.toml"
        if config_path.exists():
            with open(config_path, "rb") as file:
                config_data = tomllib.load(file)
        else:
            print(f"[WARNING]: config.toml not found for satellite {manifest.name}. Using empty config.")
            config_data = {}
        config = SatelliteConfig(
            data=config_data,
            path=config_path,
        )
        package = f"satellites.{satellite_type}.{satellite_dir.name}"
        register_package(package, satellite_dir)
        state_provider = self._load_state_provider(satellite_dir, package, manifest.name)
        routes = self._load_routes(satellite_dir, package, manifest.name)
        page = self._load_page(satellite_dir)
        lifecycle = self._load_lifecycle(satellite_dir, package, manifest.name)
        return Satellite(manifest, config, satellite_type, satellite_dir, state_provider, routes, page, lifecycle)

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
