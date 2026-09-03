from pathlib import Path
import tomllib

from .satellite import Satellite
from .satellite_registry import SatelliteRegistry
from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig
from .module_loader import load_module_from_file, register_package


class SatelliteLoader:
    def __init__(self, registry: SatelliteRegistry, native_path: Path, link_path: Path):
        self.registry = registry
        self.native_path = native_path
        self.link_path = link_path

    def _discover_directory(self, path: Path, satellite_type: str):
        if path.exists():
            for satellite_dir in path.iterdir():
                if satellite_dir.is_dir():
                    manifest_path = satellite_dir / "satellite.toml"
                    if manifest_path.exists():
                        with open(manifest_path, "rb") as file:
                            manifest_data = tomllib.load(file)
                    else:
                        print(f"[WARNING]: satellite.toml not found for satellite in {satellite_dir}. Skipping.")
                        continue
                    manifest = SatelliteManifest(
                        name=manifest_data["name"],
                        version=manifest_data["version"],
                        author=manifest_data["author"],
                        description=manifest_data["description"]
                    )
                    config_path = satellite_dir / "config.toml"
                    if config_path.exists():
                        with open(config_path, "rb") as file:
                            config_data = tomllib.load(file)
                    else:
                        print(f"[WARNING]: config.toml not found for satellite {manifest.name}. Using empty config.")
                        config_data = {}
                    config = SatelliteConfig(
                        data=config_data
                    )
                    package = f"satellites.{satellite_type}.{satellite_dir.name}"
                    register_package(package, satellite_dir)
                    state_provider = self._load_state_provider(satellite_dir, package, manifest.name)
                    routes = self._load_routes(satellite_dir, package, manifest.name)
                    page = self._load_page(satellite_dir)
                    lifecycle = self._load_lifecycle(satellite_dir, package, manifest.name)
                    satellite = Satellite(manifest, config, satellite_type, satellite_dir, state_provider, routes,
                                          page, lifecycle)
                    self.registry.add(satellite)

        else:
            print(f"[WARNING]: Directory {path} does not exist. Skipping discovery for {satellite_type} satellites.")
            return

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
