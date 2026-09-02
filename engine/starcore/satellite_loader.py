from pathlib import Path
import tomllib

from .satellite import Satellite
from .satellite_registry import SatelliteRegistry
from .manifest import SatelliteManifest
from .satellite_config import SatelliteConfig
from .module_loader import load_module_from_file


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
                    state_provider = self._load_state_provider(satellite_dir, satellite_type, manifest.name)
                    satellite = Satellite(manifest, config, satellite_type, satellite_dir, state_provider)
                    self.registry.add(satellite)

        else:
            print(f"[WARNING]: Directory {path} does not exist. Skipping discovery for {satellite_type} satellites.")
            return

    def _load_state_provider(self, satellite_dir: Path, satellite_type: str, satellite_name: str):
        state_path = satellite_dir / "state.py"
        if not state_path.exists():
            return None

        module_name = f"satellites.{satellite_type}.{satellite_dir.name}.state"
        try:
            module = load_module_from_file(module_name, state_path)
        except Exception as error:
            print(f"[WARNING]: state module of satellite '{satellite_name}' could not be loaded ({error}). Skipping.")
            return None

        provider = getattr(module, "state", None)
        if provider is None:
            print(f"[WARNING]: {state_path} has no entry function 'state'. Skipping.")

        return provider
